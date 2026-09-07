import "server-only";
import { scanStateTtlMs } from "@/lib/domain/transient-retention";
import { Prisma, type EmailProviderName, type PrismaClient, type ScanState } from "@prisma/client";
import type { InboxReport } from "@/lib/domain/types";
import type { GmailScalableCleanupTarget } from "@/lib/providers/gmail/scalable-targets";
import { decryptCleanupState, encryptCleanupState } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";

export type BenchmarkLimit = 5000 | 10000 | 25000 | 50000 | 100000 | "full";
export type BenchmarkStatus = "idle" | "running" | "completed" | "failed" | "cancelled";
export type LiveScanProvider = "gmail" | "microsoft";

export type BenchmarkProgress = {
  scanId: string;
  provider: LiveScanProvider;
  status: BenchmarkStatus;
  limit: BenchmarkLimit;
  batchSize: number;
  processed: number;
  mailboxPath?: string;
  mailboxExists?: number;
  startedAt: number;
  completedAt?: number;
  connectionMs?: number;
  conversationIndexMs?: number;
  metadataMs?: number;
  subjectProtectionMs?: number;
  protectionClassificationMs?: number;
  aggregationMs?: number;
  durationMs?: number;
  messagesPerSecond?: number;
  messagesPerMinute?: number;
  approxMemoryMb?: number;
  peakParticipatedConversationCount?: number;
  graphPages?: number;
  graphRequests?: number;
  graphScanMode?: "full" | "delta";
  graphFoldersScanned?: number;
  graphMaxConcurrentRequests?: number;
  graphMetadataRequests?: number;
  graphHeaderEnrichmentRequests?: number;
  graphMessagesEnriched?: number;
  graphMainMessagePageSize?: number;
  graphMainMessagePageSizes?: number[];
  graphMainMessagePages?: number;
  graphMainMessagePageFallbacks?: number;
  graph429WaitMs?: number;
  graphPeakScanMemoryMb?: number;
  outlookTransport?: "graph" | "imap";
  imapFolders?: number;
  imapMetadataBatches?: number;
  imapCommands?: number;
  imapRetries?: number;
  imapErrors?: number;
  imapPeakScanMemoryMb?: number;
  graphRetries?: number;
  graphTokenRefreshes?: number;
  graph401Failures?: number;
  graph403Failures?: number;
  graph429Throttles?: number;
  graph5xxFailures?: number;
  graphOther4xxFailures?: number;
  graphLastOther4xxStatus?: number;
  graphLastOther4xxCategory?: string;
  graphLastOther4xxOperation?: string;
  graphLastNonHttpFailureOperation?: string;
  graphLastNonHttpFailureCategory?: string;
  graphEvidenceAvailability?: {
    conversationIdentity: boolean;
    importance: boolean;
    categories: boolean;
    listId: boolean;
    listUnsubscribe: boolean;
    autoSubmitted: boolean;
    precedence: boolean;
  };
  duplicateStartCount: number;
  errors: string[];
  notes: string[];
};

export type LiveScanSession = {
  progress: BenchmarkProgress;
  report?: InboxReport;
  participatedConversationIds?: Set<string>;
  expiresAt: number;
  reportStale?: boolean;
  gmailUidValidity?: string;
  scalableCleanupTargets?: GmailScalableCleanupTarget[];
};

type SerializedLiveScanSession = Omit<LiveScanSession, "participatedConversationIds"> & {
  participatedConversationIds?: string[];
};

export type ScanStateRow = Pick<
  ScanState,
  | "userId"
  | "provider"
  | "scanId"
  | "providerConnectionId"
  | "status"
  | "encryptedPayload"
  | "version"
  | "lockOwner"
  | "lockExpiresAt"
  | "expiresAt"
  | "createdAt"
  | "updatedAt"
>;

type NewScanStateRow = Omit<ScanStateRow, "createdAt" | "updatedAt">;

export interface ScanStateRepository {
  accept(row: NewScanStateRow): Promise<{ row: ScanStateRow; created: boolean }>;
  find(userId: string, provider?: LiveScanProvider): Promise<ScanStateRow | null>;
  findByScanId(scanId: string): Promise<ScanStateRow | null>;
  replace(input: {
    userId: string;
    provider: LiveScanProvider;
    scanId: string;
    expectedVersion: number;
    encryptedPayload: string;
    status: ScanState["status"];
    expiresAt: Date;
    lockOwner?: string;
  }): Promise<boolean>;
  claim(input: { scanId: string; owner: string; now: Date; lockExpiresAt: Date }): Promise<boolean>;
  release(scanId: string, owner: string): Promise<boolean>;
  delete(userId: string, provider?: LiveScanProvider): Promise<number>;
}

const ttlMs = scanStateTtlMs;

export class DurableLiveScanStore {
  constructor(private readonly repository: ScanStateRepository = new PrismaScanStateRepository(prisma)) {}

  async accept(input: { userId: string; providerConnectionId: string; session: LiveScanSession }) {
    const provider = input.session.progress.provider;
    const stored = normalizeSession(input.session);
    const result = await this.repository.accept({
      userId: input.userId,
      provider,
      scanId: stored.progress.scanId,
      providerConnectionId: input.providerConnectionId,
      status: toScanStatus(stored.progress.status),
      encryptedPayload: encodeSession(stored),
      version: 1,
      lockOwner: null,
      lockExpiresAt: null,
      expiresAt: new Date(stored.expiresAt)
    });
    const session = decodeAndValidate(result.row);
    if (!result.created) {
      session.progress.duplicateStartCount += 1;
      return { session: (await this.set(result.row.userId, session, result.row.provider)) ?? session, reused: true };
    }
    return { session, reused: false };
  }

  async get(userId: string, provider?: LiveScanProvider, now = new Date()) {
    const row = await this.repository.find(userId, provider);
    if (!row || row.expiresAt.getTime() <= now.getTime()) return undefined;
    return decodeAndValidate(row);
  }

  async getByScanId(scanId: string, now = new Date()) {
    const row = await this.repository.findByScanId(scanId);
    if (!row || row.expiresAt.getTime() <= now.getTime()) return undefined;
    return decodeAndValidate(row);
  }

  async getExecutionContext(scanId: string, now = new Date()) {
    const row = await this.repository.findByScanId(scanId);
    if (!row || row.expiresAt.getTime() <= now.getTime()) return undefined;
    return {
      userId: row.userId,
      providerConnectionId: row.providerConnectionId,
      lockOwner: row.lockOwner,
      session: decodeAndValidate(row)
    };
  }

  async set(
    userId: string,
    session: LiveScanSession,
    provider = session.progress.provider,
    lockOwner?: string
  ) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await this.repository.find(userId, provider);
      if (!row || row.scanId !== session.progress.scanId) return undefined;
      if (row.lockOwner && row.lockOwner !== lockOwner) return undefined;
      const stored = normalizeSession(session);
      const replaced = await this.repository.replace({
        userId,
        provider,
        scanId: row.scanId,
        expectedVersion: row.version,
        encryptedPayload: encodeSession(stored),
        status: toScanStatus(stored.progress.status),
        expiresAt: new Date(stored.expiresAt),
        lockOwner
      });
      if (replaced) return stored;
    }
    return undefined;
  }

  async update(userId: string, provider: LiveScanProvider, update: (session: LiveScanSession) => LiveScanSession | void) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await this.repository.find(userId, provider);
      if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;
      const session = decodeAndValidate(row);
      const next = normalizeSession(update(session) ?? session);
      const replaced = await this.repository.replace({
        userId,
        provider,
        scanId: row.scanId,
        expectedVersion: row.version,
        encryptedPayload: encodeSession(next),
        status: toScanStatus(next.progress.status),
        expiresAt: new Date(next.expiresAt),
        lockOwner: row.lockOwner ?? undefined
      });
      if (replaced) return next;
    }
    return undefined;
  }

  async claim(scanId: string, owner: string, now = new Date(), ttl = 10 * 60 * 1000) {
    const claimed = await this.repository.claim({ scanId, owner, now, lockExpiresAt: new Date(now.getTime() + ttl) });
    return claimed ? this.getByScanId(scanId, now) : undefined;
  }

  release(scanId: string, owner: string) {
    return this.repository.release(scanId, owner);
  }

  delete(userId: string, provider?: LiveScanProvider) {
    return this.repository.delete(userId, provider);
  }

  async hasExpired(userId: string, provider?: LiveScanProvider, now = new Date()) {
    const row = await this.repository.find(userId, provider);
    return Boolean(row && row.expiresAt.getTime() <= now.getTime());
  }
}

export class PrismaScanStateRepository implements ScanStateRepository {
  constructor(private readonly client: PrismaClient) {}

  async accept(row: NewScanStateRow) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.client.$transaction(async (transaction) => {
          const current = await transaction.scanState.findUnique({
            where: { userId_provider: { userId: row.userId, provider: row.provider } }
          });
          if (current && current.status === "running" && current.expiresAt > new Date()) {
            return { row: current, created: false };
          }
          if (current) {
            await transaction.scanState.delete({
              where: { userId_provider: { userId: row.userId, provider: row.provider } }
            });
          }
          await transaction.scan.create({
            data: {
              id: row.scanId,
              userId: row.userId,
              providerConnectionId: row.providerConnectionId,
              provider: row.provider,
              status: row.status,
              startedAt: new Date()
            }
          });
          const created = await transaction.scanState.create({ data: row });
          return { row: created, created: true };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!isRetryableAcceptanceError(error) || attempt === 3) throw error;
        const current = await this.find(row.userId, row.provider);
        if (current?.status === "running" && current.expiresAt > new Date()) {
          return { row: current, created: false };
        }
      }
    }
    throw new Error("Scan acceptance could not be resolved.");
  }

  find(userId: string, provider?: LiveScanProvider) {
    return provider
      ? this.client.scanState.findUnique({ where: { userId_provider: { userId, provider } } })
      : this.client.scanState.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
  }

  findByScanId(scanId: string) {
    return this.client.scanState.findUnique({ where: { scanId } });
  }

  async replace(input: {
    userId: string;
    provider: LiveScanProvider;
    scanId: string;
    expectedVersion: number;
    encryptedPayload: string;
    status: ScanState["status"];
    expiresAt: Date;
    lockOwner?: string;
  }) {
    return this.client.$transaction(async (transaction) => {
      const result = await transaction.scanState.updateMany({
        where: {
          userId: input.userId,
          provider: input.provider,
          scanId: input.scanId,
          version: input.expectedVersion,
          ...(input.lockOwner ? { lockOwner: input.lockOwner } : {})
        },
        data: {
          encryptedPayload: input.encryptedPayload,
          status: input.status,
          expiresAt: input.expiresAt,
          ...(input.lockOwner ? { lockExpiresAt: new Date(Date.now() + 10 * 60 * 1000) } : {}),
          version: { increment: 1 }
        }
      });
      if (result.count !== 1) return false;
      await transaction.scan.update({
        where: { id: input.scanId },
        data: {
          status: input.status,
          completedAt: ["completed", "failed", "cancelled"].includes(input.status) ? new Date() : null
        }
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async claim(input: { scanId: string; owner: string; now: Date; lockExpiresAt: Date }) {
    const result = await this.client.scanState.updateMany({
      where: {
        scanId: input.scanId,
        status: "running",
        expiresAt: { gt: input.now },
        OR: [{ lockOwner: null }, { lockExpiresAt: null }, { lockExpiresAt: { lte: input.now } }]
      },
      data: { lockOwner: input.owner, lockExpiresAt: input.lockExpiresAt }
    });
    return result.count === 1;
  }

  async release(scanId: string, owner: string) {
    const result = await this.client.scanState.updateMany({
      where: { scanId, lockOwner: owner },
      data: { lockOwner: null, lockExpiresAt: null }
    });
    return result.count === 1;
  }

  async delete(userId: string, provider?: LiveScanProvider) {
    return (await this.client.scanState.deleteMany({ where: { userId, ...(provider ? { provider } : {}) } })).count;
  }
}

export class MemoryScanStateRepository implements ScanStateRepository {
  private readonly rows = new Map<string, ScanStateRow>();

  async accept(row: NewScanStateRow) {
    const key = scanKey(row.userId, row.provider);
    const current = this.rows.get(key);
    if (current?.status === "running" && current.expiresAt > new Date()) {
      return { row: structuredClone(current), created: false };
    }
    const now = new Date();
    const created = { ...structuredClone(row), createdAt: now, updatedAt: now };
    this.rows.set(key, created);
    return { row: structuredClone(created), created: true };
  }

  async find(userId: string, provider?: LiveScanProvider) {
    if (provider) return structuredClone(this.rows.get(scanKey(userId, provider)) ?? null);
    const row = [...this.rows.values()]
      .filter((candidate) => candidate.userId === userId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
    return structuredClone(row ?? null);
  }

  async findByScanId(scanId: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.scanId === scanId);
    return structuredClone(row ?? null);
  }

  async replace(input: {
    userId: string;
    provider: LiveScanProvider;
    scanId: string;
    expectedVersion: number;
    encryptedPayload: string;
    status: ScanState["status"];
    expiresAt: Date;
    lockOwner?: string;
  }) {
    const key = scanKey(input.userId, input.provider);
    const row = this.rows.get(key);
    if (!row || row.scanId !== input.scanId || row.version !== input.expectedVersion) return false;
    if (input.lockOwner && row.lockOwner !== input.lockOwner) return false;
    this.rows.set(key, {
      ...row,
      encryptedPayload: input.encryptedPayload,
      status: input.status,
      expiresAt: input.expiresAt,
      version: row.version + 1,
      updatedAt: new Date()
    });
    if (input.lockOwner) {
      const updated = this.rows.get(key);
      if (updated) updated.lockExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    }
    return true;
  }

  async claim(input: { scanId: string; owner: string; now: Date; lockExpiresAt: Date }) {
    const row = [...this.rows.values()].find((candidate) => candidate.scanId === input.scanId);
    if (!row || row.status !== "running" || row.expiresAt <= input.now) return false;
    if (row.lockOwner && row.lockExpiresAt && row.lockExpiresAt > input.now) return false;
    row.lockOwner = input.owner;
    row.lockExpiresAt = input.lockExpiresAt;
    return true;
  }

  async release(scanId: string, owner: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.scanId === scanId);
    if (!row || row.lockOwner !== owner) return false;
    row.lockOwner = null;
    row.lockExpiresAt = null;
    return true;
  }

  async delete(userId: string, provider?: LiveScanProvider) {
    let deleted = 0;
    for (const [key, row] of this.rows) {
      if (row.userId === userId && (!provider || row.provider === provider)) {
        this.rows.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

const defaultStore = new DurableLiveScanStore();

export function acceptLiveScan(input: { userId: string; providerConnectionId: string; session: LiveScanSession }) {
  return defaultStore.accept(input);
}
export function setLiveScan(
  userId: string,
  session: LiveScanSession,
  provider?: LiveScanProvider,
  lockOwner?: string
) {
  return defaultStore.set(userId, session, provider, lockOwner);
}
export function getLiveScan(userId: string, provider?: LiveScanProvider) {
  return defaultStore.get(userId, provider);
}
export function getLiveScanById(scanId: string) {
  return defaultStore.getByScanId(scanId);
}
export function getLiveScanExecutionContext(scanId: string) {
  return defaultStore.getExecutionContext(scanId);
}
export function clearLiveScan(userId: string, provider?: LiveScanProvider) {
  return defaultStore.delete(userId, provider);
}
export async function reuseRunningLiveScan(userId: string, provider?: LiveScanProvider) {
  const session = await defaultStore.get(userId, provider);
  if (!session || session.progress.status !== "running") return undefined;
  session.progress.duplicateStartCount += 1;
  return defaultStore.set(userId, session, session.progress.provider);
}
export function hasExpiredLiveScan(userId: string, provider?: LiveScanProvider) {
  return defaultStore.hasExpired(userId, provider);
}
export function markLiveReportStale(userId: string, provider?: LiveScanProvider) {
  return provider
    ? defaultStore.update(userId, provider, markSessionStale)
    : markLatestLiveReportStale(userId);
}
async function markLatestLiveReportStale(userId: string) {
  const session = await defaultStore.get(userId);
  return session ? defaultStore.update(userId, session.progress.provider, markSessionStale) : undefined;
}
export function claimLiveScan(scanId: string, owner: string) {
  return defaultStore.claim(scanId, owner);
}
export function releaseLiveScan(scanId: string, owner: string) {
  return defaultStore.release(scanId, owner);
}
export async function cancelLiveScan(userId: string, provider: LiveScanProvider) {
  return defaultStore.update(userId, provider, (session) => {
    if (session.progress.status !== "running") return session;
    session.progress.status = "cancelled";
    session.progress.completedAt = Date.now();
    session.progress.durationMs = session.progress.completedAt - session.progress.startedAt;
    session.progress.notes.push("Benchmark cancellation requested.");
    return session;
  });
}

function markSessionStale(session: LiveScanSession) {
  session.reportStale = true;
  const note = "Inbox changed since this report was generated. Run a fresh scan before another cleanup.";
  if (!session.progress.notes.includes(note)) session.progress.notes.push(note);
  return session;
}

export function createProgress(input: {
  scanId: string;
  limit: BenchmarkLimit;
  batchSize: number;
  provider?: LiveScanProvider;
}): BenchmarkProgress {
  return {
    scanId: input.scanId,
    provider: input.provider ?? "gmail",
    status: "running",
    limit: input.limit,
    batchSize: input.batchSize,
    processed: 0,
    startedAt: Date.now(),
    duplicateStartCount: 0,
    errors: [],
    notes: []
  };
}

export function nextExpiry() {
  return Date.now() + ttlMs;
}

export const transientReportStore = {
  get: getLiveScan,
  set: setLiveScan,
  touch: getLiveScan,
  delete: clearLiveScan,
  async hasActiveReport(userId: string, provider?: LiveScanProvider) {
    const session = await getLiveScan(userId, provider);
    return Boolean(session?.report && session.progress.status === "completed");
  }
};

function encodeSession(session: LiveScanSession) {
  const serialized: SerializedLiveScanSession = {
    ...session,
    participatedConversationIds: session.participatedConversationIds ? [...session.participatedConversationIds] : undefined
  };
  return encryptCleanupState(JSON.stringify(serialized));
}

function decodeSession(value: string): LiveScanSession {
  try {
    const parsed = JSON.parse(decryptCleanupState(value)) as SerializedLiveScanSession;
    return {
      ...parsed,
      participatedConversationIds: parsed.participatedConversationIds ? new Set(parsed.participatedConversationIds) : undefined
    };
  } catch {
    throw new Error("Transient scan state could not be authenticated.");
  }
}

function decodeAndValidate(row: ScanStateRow) {
  const session = decodeSession(row.encryptedPayload);
  if (session.progress.scanId !== row.scanId || session.progress.provider !== row.provider) {
    throw new Error("Transient scan state identity does not match its envelope.");
  }
  return normalizeSession(session);
}

function normalizeSession(session: LiveScanSession): LiveScanSession {
  return structuredClone({ ...session, expiresAt: Math.max(session.expiresAt, nextExpiry()) });
}

function toScanStatus(status: BenchmarkStatus): ScanState["status"] {
  return status === "idle" ? "pending" : status;
}

function scanKey(userId: string, provider: EmailProviderName) {
  return `${userId}:${provider}`;
}

function isRetryableAcceptanceError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code);
}

export function serializeBenchmark(progress: BenchmarkProgress) {
  return {
    scanId: progress.scanId,
    provider: progress.provider,
    status: progress.status,
    limit: progress.limit,
    batchSize: progress.batchSize,
    processed: progress.processed,
    mailboxExists: progress.mailboxExists,
    startedAt: progress.startedAt,
    completedAt: progress.completedAt,
    connectionMs: progress.connectionMs,
    conversationIndexMs: progress.conversationIndexMs,
    metadataMs: progress.metadataMs,
    subjectProtectionMs: progress.subjectProtectionMs,
    protectionClassificationMs: progress.protectionClassificationMs,
    aggregationMs: progress.aggregationMs,
    durationMs: progress.durationMs,
    messagesPerSecond: progress.messagesPerSecond,
    messagesPerMinute: progress.messagesPerMinute,
    approxMemoryMb: progress.approxMemoryMb,
    peakParticipatedConversationCount: progress.peakParticipatedConversationCount,
    graphPages: progress.graphPages,
    graphRequests: progress.graphRequests,
    graphScanMode: progress.graphScanMode,
    graphFoldersScanned: progress.graphFoldersScanned,
    graphMaxConcurrentRequests: progress.graphMaxConcurrentRequests,
    graphMetadataRequests: progress.graphMetadataRequests,
    graphHeaderEnrichmentRequests: progress.graphHeaderEnrichmentRequests,
    graphMessagesEnriched: progress.graphMessagesEnriched,
    graphMainMessagePageSize: progress.graphMainMessagePageSize,
    graphMainMessagePageSizes: progress.graphMainMessagePageSizes,
    graphMainMessagePages: progress.graphMainMessagePages,
    graphMainMessagePageFallbacks: progress.graphMainMessagePageFallbacks,
    graph429WaitMs: progress.graph429WaitMs,
    graphPeakScanMemoryMb: progress.graphPeakScanMemoryMb,
    outlookTransport: progress.outlookTransport,
    imapFolders: progress.imapFolders,
    imapMetadataBatches: progress.imapMetadataBatches,
    imapCommands: progress.imapCommands,
    imapRetries: progress.imapRetries,
    imapErrors: progress.imapErrors,
    imapPeakScanMemoryMb: progress.imapPeakScanMemoryMb,
    graphRetries: progress.graphRetries,
    graphTokenRefreshes: progress.graphTokenRefreshes,
    graph401Failures: progress.graph401Failures,
    graph403Failures: progress.graph403Failures,
    graph429Throttles: progress.graph429Throttles,
    graph5xxFailures: progress.graph5xxFailures,
    graphOther4xxFailures: progress.graphOther4xxFailures,
    graphLastOther4xxStatus: progress.graphLastOther4xxStatus,
    graphLastOther4xxCategory: progress.graphLastOther4xxCategory,
    graphLastOther4xxOperation: progress.graphLastOther4xxOperation,
    graphLastNonHttpFailureOperation: progress.graphLastNonHttpFailureOperation,
    graphLastNonHttpFailureCategory: progress.graphLastNonHttpFailureCategory,
    graphEvidenceAvailability: progress.graphEvidenceAvailability,
    duplicateStartCount: progress.duplicateStartCount,
    errors: progress.errors,
    notes: progress.notes
  };
}

export const serializeScanProgress = serializeBenchmark;
