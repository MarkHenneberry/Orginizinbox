import "server-only";
import { measureVerification, measureVerificationSync } from "@/lib/server/outlook-verification-timing";
import { accountVerifiedProgress, creditProgressChanged, type VerifiedCreditProgress } from "@/lib/billing/credits";
import type { OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";
import { expiredUnlockedStateWhere } from "@/lib/domain/transient-retention";
import type { CleanupJobState, PrismaClient, Prisma } from "@prisma/client";
import { runtimeConfig } from "@/lib/config";
import {
  decryptCleanupState,
  encryptCleanupState
} from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import type { GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";
import { encodeOutlookStorage, hydrateOutlookStorage, isChunkedCleanupState, type ChunkCache, type ChunkWrite, type StorageWrite } from "@/lib/server/outlook-state-chunks";

export type CleanupJobStateRow = Pick<
  CleanupJobState,
  | "jobId"
  | "userId"
  | "encryptedPayload"
  | "version"
  | "lockOwner"
  | "lockExpiresAt"
  | "expiresAt"
  | "createdAt"
  | "updatedAt"
> & { hydratedJob?: DurableCleanupJobEnvelope };

export type DurableCleanupJobEnvelope = {
  creditBilling?: true;
  userId: string;
  version: number;
  view: { id: string; expiresAt: number };
};

export type CleanupJobStateCodec<TJob extends DurableCleanupJobEnvelope = GmailScalableStoredJob> = {
  encode(job: TJob): string;
  decode(value: string): TJob;
};

export type CleanupJobStateRepository = {
  prepare?<T extends DurableCleanupJobEnvelope>(job: T, codec: CleanupJobStateCodec<T>): StorageWrite;
  create(row: Omit<CleanupJobStateRow, "createdAt" | "updatedAt"> & { chunkWrite?: ChunkWrite }): Promise<CleanupJobStateRow>;
  find(jobId: string): Promise<CleanupJobStateRow | null>;
  replaceIfVersion(input: {
    jobId: string;
    userId: string;
    expectedVersion: number;
    now: Date;
    lockOwner?: string;
    encryptedPayload: string;
    expiresAt: Date;
    creditProgress?: VerifiedCreditProgress;
    chunkWrite?: ChunkWrite;
  }): Promise<boolean>;
  claim(input: { jobId: string; owner: string; now: Date; lockExpiresAt: Date }): Promise<boolean>;
  refreshLock(input: { jobId: string; owner: string; now: Date; lockExpiresAt: Date }): Promise<boolean>;
  releaseLock(jobId: string, owner: string): Promise<boolean>;
  delete(jobId: string, userId?: string): Promise<boolean>;
  deleteForUser(userId: string): Promise<number>;
  deleteExpired(now: Date, jobId?: string): Promise<number>;
};

export interface DurableCleanupStore<TJob extends DurableCleanupJobEnvelope> {
  create(job: TJob): Promise<TJob>;
  get(userId: string, jobId: string, now?: Date): Promise<TJob | undefined>;
  getByJobId(jobId: string, now?: Date): Promise<TJob | undefined>;
  compareAndSet(
    userId: string,
    jobId: string,
    expectedVersion: number,
    update: (job: TJob) => TJob,
    now?: Date,
    lockOwner?: string
  ): Promise<TJob | undefined>;
  claim(jobId: string, owner: string, now?: Date, ttlMs?: number): Promise<TJob | undefined>;
  refreshLock(jobId: string, owner: string, now?: Date, ttlMs?: number): Promise<boolean>;
  releaseLock(jobId: string, owner: string): Promise<boolean>;
  delete(userId: string, jobId: string): Promise<boolean>;
  deleteForUser(userId: string): Promise<number>;
  purgeExpired(now?: Date): Promise<number>;
}

export type GmailScalableDurableCleanupStore = DurableCleanupStore<GmailScalableStoredJob>;

export class PrismaCleanupJobStore<TJob extends DurableCleanupJobEnvelope> implements DurableCleanupStore<TJob> {
  constructor(
    private readonly repository: CleanupJobStateRepository = new PrismaCleanupJobStateRepository(prisma),
    private readonly codec: CleanupJobStateCodec<TJob> = createCleanupJobStateCodec<TJob>()
  ) {}

  async create(job: TJob) {
    const stored = normalizeJob(job, 1);
    const storage = this.repository.prepare?.(stored, this.codec) ?? { encryptedPayload: this.codec.encode(stored) };
    await this.repository.create({
      jobId: stored.view.id,
      userId: stored.userId,
      ...storage,
      version: stored.version,
      lockOwner: null,
      lockExpiresAt: null,
      expiresAt: new Date(stored.view.expiresAt)
    });
    return cloneJob(stored);
  }

  async get(userId: string, jobId: string, now = new Date()) {
    const job = await this.getByJobId(jobId, now);
    return job?.userId === userId ? job : undefined;
  }

  async getByJobId(jobId: string, now = new Date()) {
    const row = await measureVerification("database_read", () => this.repository.find(jobId));
    if (!row) return undefined;
    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.repository.deleteExpired(now, jobId);
      return undefined;
    }
    return measureVerificationSync("decrypt_deserialize", () => decodeAndValidate(row, this.codec));
  }

  async compareAndSet(
    userId: string,
    jobId: string,
    expectedVersion: number,
    update: (job: TJob) => TJob,
    now = new Date(),
    lockOwner?: string
  ) {
    const row = await measureVerification("database_read", () => this.repository.find(jobId));
    if (!row || row.userId !== userId || row.version !== expectedVersion) return undefined;
    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.repository.deleteExpired(now, jobId);
      return undefined;
    }
    const current = measureVerificationSync("decrypt_deserialize", () => decodeAndValidate(row, this.codec));
    const next = normalizeJob(update(cloneJob(current)), expectedVersion + 1);
    if (next.userId !== userId || next.view.id !== jobId) {
      throw new CleanupStateIntegrityError("Cleanup state identity cannot change.");
    }
    if (next.view.expiresAt <= now.getTime()) return undefined;
    const storage = measureVerificationSync("encrypt_serialize", () => this.repository.prepare?.(next, this.codec) ?? { encryptedPayload: this.codec.encode(next) });
    const replaced = await measureVerification("database_write", () => this.repository.replaceIfVersion({
      jobId,
      userId,
      expectedVersion,
      now,
      lockOwner,
      ...storage,
      expiresAt: new Date(next.view.expiresAt),
      creditProgress: creditProgressChanged(verifiedCreditProgress(current), verifiedCreditProgress(next)) ? verifiedCreditProgress(next) : undefined
    }));
    return replaced ? cloneJob(next) : undefined;
  }

  async claim(
    jobId: string,
    owner: string,
    now = new Date(),
    ttlMs = runtimeConfig.cleanupStateLockTtlSeconds * 1_000
  ) {
    if (!owner) throw new Error("Cleanup state lock owner is required.");
    const claimed = await measureVerification("database_write", () => this.repository.claim({
      jobId,
      owner,
      now,
      lockExpiresAt: new Date(now.getTime() + ttlMs)
    }));
    return claimed ? this.getByJobId(jobId, now) : undefined;
  }

  refreshLock(
    jobId: string,
    owner: string,
    now = new Date(),
    ttlMs = runtimeConfig.cleanupStateLockTtlSeconds * 1_000
  ) {
    return this.repository.refreshLock({
      jobId,
      owner,
      now,
      lockExpiresAt: new Date(now.getTime() + ttlMs)
    });
  }

  releaseLock(jobId: string, owner: string) {
    return measureVerification("database_write", () => this.repository.releaseLock(jobId, owner));
  }

  delete(userId: string, jobId: string) {
    return this.repository.delete(jobId, userId);
  }

  deleteForUser(userId: string) {
    return this.repository.deleteForUser(userId);
  }

  purgeExpired(now = new Date()) {
    return this.repository.deleteExpired(now);
  }
}

export class PrismaGmailScalableCleanupStore extends PrismaCleanupJobStore<GmailScalableStoredJob> {}

export class PrismaCleanupJobStateRepository implements CleanupJobStateRepository {
  private cache: ChunkCache = new Map();
  private cacheJob?: string;
  constructor(private readonly client: PrismaClient) {}

  private useJob(jobId: string) {
    if (this.cacheJob !== jobId) { this.cache.clear(); this.cacheJob = jobId; }
  }

  prepare<T extends DurableCleanupJobEnvelope>(job: T, codec: CleanupJobStateCodec<T>) {
    this.useJob(job.view.id);
    return encodeOutlookStorage(job, codec, this.cache);
  }

  async create(row: Omit<CleanupJobStateRow, "createdAt" | "updatedAt"> & { chunkWrite?: ChunkWrite }) {
    const { chunkWrite, ...rest } = row;
    const data = { ...rest }; delete data.hydratedJob;
    const result = chunkWrite ? await this.client.$transaction(async tx => {
      const created = await tx.cleanupJobState.create({ data });
      await writeCleanupStateChunks(tx, row.jobId, chunkWrite);
      return created;
    }, { isolationLevel: "Serializable", timeout: 15_000 }) : await this.client.cleanupJobState.create({ data });
    this.useJob(row.jobId); this.cache = chunkWrite?.cache ?? new Map();
    return result;
  }

  async find(jobId: string): Promise<CleanupJobStateRow | null> {
    this.useJob(jobId);
    const row = await this.client.cleanupJobState.findUnique({ where: { jobId } });
    if (!row) return null;
    if (row.expiresAt <= new Date()) return row;
    const codec = createCleanupJobStateCodec<DurableCleanupJobEnvelope>();
    const decoded = codec.decode(row.encryptedPayload);
    if (!isChunkedCleanupState(decoded)) return { ...row, hydratedJob: decoded };
    if (decoded.userId !== row.userId || decoded.view.id !== row.jobId || decoded.version !== row.version) throw new CleanupStateIntegrityError();
    if (!decoded.outlookStorage || decoded.outlookStorage.format !== "outlook-chunks-v1" || !Array.isArray(decoded.outlookStorage.arrays)) throw new CleanupStateIntegrityError();
    const complete = decoded.outlookStorage.arrays.every(array => array.pages.every(page => page.every(ref => this.cache.get(ref.slot)?.digest === ref.digest)));
    if (complete) return { ...row, hydratedJob: await hydrateOutlookStorage(decoded, codec, this.client, this.cache) };
    // Parent and all bounded child reads share one snapshot, never mixed versions.
    return this.client.$transaction(async tx => {
      const current = await tx.cleanupJobState.findUnique({ where: { jobId } });
      if (!current) return null;
      return hydrateCleanupJobStateRow(current, tx, this.cache);
    }, { isolationLevel: "RepeatableRead", timeout: 15_000 });
  }

  async replaceIfVersion(input: {
    jobId: string;
    userId: string;
    expectedVersion: number;
    now: Date;
    lockOwner?: string;
    encryptedPayload: string;
    expiresAt: Date;
    creditProgress?: VerifiedCreditProgress;
    chunkWrite?: ChunkWrite;
  }) {
    const result = await this.client.$transaction(async (transaction) => {
      const result = await transaction.cleanupJobState.updateMany({
        where: {
          jobId: input.jobId,
          userId: input.userId,
          version: input.expectedVersion,
          expiresAt: { gt: input.now },
          ...(input.lockOwner
            ? { lockOwner: input.lockOwner, lockExpiresAt: { gt: input.now } }
            : {})
        },
        data: {
          encryptedPayload: input.encryptedPayload,
          expiresAt: input.expiresAt,
          version: { increment: 1 }
        }
      });
      if (result.count === 1 && input.chunkWrite) await writeCleanupStateChunks(transaction, input.jobId, input.chunkWrite);
      if (result.count === 1 && input.creditProgress) {
        await accountVerifiedProgress(transaction, input.userId, input.jobId, input.creditProgress);
      }
      return result;
    },
      { isolationLevel: "Serializable", ...(input.chunkWrite ? { timeout: 15_000 } : {}) }
    );
    if (result.count === 1) {
      this.useJob(input.jobId); this.cache = input.chunkWrite?.cache ?? new Map();
    }
    return result.count === 1;
  }

  async claim(input: { jobId: string; owner: string; now: Date; lockExpiresAt: Date }) {
    const result = await this.client.$transaction((transaction) =>
      transaction.cleanupJobState.updateMany({
        where: {
          jobId: input.jobId,
          expiresAt: { gt: input.now },
          OR: [
            { lockOwner: null },
            { lockExpiresAt: null },
            { lockExpiresAt: { lte: input.now } }
          ]
        },
        data: { lockOwner: input.owner, lockExpiresAt: input.lockExpiresAt }
      }),
      { isolationLevel: "Serializable" }
    );
    return result.count === 1;
  }

  async refreshLock(input: { jobId: string; owner: string; now: Date; lockExpiresAt: Date }) {
    const result = await this.client.cleanupJobState.updateMany({
      where: {
        jobId: input.jobId,
        lockOwner: input.owner,
        lockExpiresAt: { gt: input.now },
        expiresAt: { gt: input.now }
      },
      data: { lockExpiresAt: input.lockExpiresAt }
    });
    return result.count === 1;
  }

  async releaseLock(jobId: string, owner: string) {
    const result = await this.client.cleanupJobState.updateMany({
      where: { jobId, lockOwner: owner },
      data: { lockOwner: null, lockExpiresAt: null }
    });
    return result.count === 1;
  }

  async delete(jobId: string, userId?: string) {
    const result = await this.client.cleanupJobState.deleteMany({ where: { jobId, ...(userId ? { userId } : {}) } });
    return result.count === 1;
  }

  async deleteForUser(userId: string) {
    return (await this.client.cleanupJobState.deleteMany({ where: { userId } })).count;
  }

  async deleteExpired(now: Date, jobId?: string) {
    return (await this.client.cleanupJobState.deleteMany({
      where: { ...expiredUnlockedStateWhere(now), ...(jobId ? { jobId } : {}) }
    })).count;
  }
}

export class CleanupStateIntegrityError extends Error {
  constructor(message = "Cleanup state could not be authenticated.") {
    super(message);
    this.name = "CleanupStateIntegrityError";
  }
}

export function decodeCleanupJobStateRow<TJob extends DurableCleanupJobEnvelope>(row: CleanupJobStateRow) {
  return decodeAndValidate(row, createCleanupJobStateCodec<TJob>());
}

export async function hydrateCleanupJobStateRow(row: CleanupJobStateRow, db: Prisma.TransactionClient, cache: ChunkCache = new Map()): Promise<CleanupJobStateRow> {
  const codec = createCleanupJobStateCodec<DurableCleanupJobEnvelope>();
  const job = codec.decode(row.encryptedPayload);
  if (job.userId !== row.userId || job.view.id !== row.jobId || job.version !== row.version) throw new CleanupStateIntegrityError();
  return { ...row, hydratedJob: await hydrateOutlookStorage(job, codec, db, cache) };
}

async function writeCleanupStateChunks(tx: Prisma.TransactionClient, jobId: string, write: ChunkWrite) {
  const fresh = new Set(write.newSlots);
  const inserts = write.rows.filter(row => fresh.has(row.slot));
  // Bound each INSERT request too; initial state must not issue hundreds of round trips.
  for (let index = 0; index < inserts.length; index += 8) await tx.cleanupJobStateChunk.createMany({ data: inserts.slice(index, index + 8).map(row => ({ jobId, ...row })) });
  for (const row of write.rows.filter(row => !fresh.has(row.slot))) await tx.cleanupJobStateChunk.upsert({
    where: { jobId_slot: { jobId, slot: row.slot } }, create: { jobId, ...row }, update: { encryptedPayload: row.encryptedPayload }
  });
  // No per-message rows; obsolete storage pages are removed in the same parent CAS.
  if (write.removedSlots.length) await tx.cleanupJobStateChunk.deleteMany({ where: { jobId, slot: { in: write.removedSlots } } });
}

export async function createPreparedCleanupJobState<T extends DurableCleanupJobEnvelope>(tx: Prisma.TransactionClient, prepared: ReturnType<typeof prepareCleanupJobState<T>>) {
  const row = await tx.cleanupJobState.create({ data: prepared.data });
  if (prepared.chunkWrite) await writeCleanupStateChunks(tx, row.jobId, prepared.chunkWrite);
  return row;
}

export function createCleanupJobStateCodec<TJob extends DurableCleanupJobEnvelope = GmailScalableStoredJob>(input?: {
  encrypt(value: string): string;
  decrypt(value: string): string;
}): CleanupJobStateCodec<TJob> {
  const crypto = input ?? { encrypt: encryptCleanupState, decrypt: decryptCleanupState };
  return {
    encode(job) {
      return crypto.encrypt(JSON.stringify(job));
    },
    decode(value) {
      try {
        return JSON.parse(crypto.decrypt(value)) as TJob;
      } catch {
        throw new CleanupStateIntegrityError();
      }
    }
  };
}

export function prepareCleanupJobState<TJob extends DurableCleanupJobEnvelope>(
  job: TJob,
  codec: CleanupJobStateCodec<TJob> = createCleanupJobStateCodec<TJob>()
) {
  const stored = normalizeJob({ ...job, ...(process.env.NODE_ENV === "production" ? { creditBilling: true as const } : {}) }, 1);
  const storage = encodeOutlookStorage(stored, codec);
  return {
    job: cloneJob(stored),
    chunkWrite: storage.chunkWrite,
    data: {
      jobId: stored.view.id,
      userId: stored.userId,
      encryptedPayload: storage.encryptedPayload,
      version: stored.version,
      lockOwner: null,
      lockExpiresAt: null,
      expiresAt: new Date(stored.view.expiresAt)
    }
  };
}

export function cleanupStateExpiryFor(input: {
  now: number;
  undoAvailable: boolean;
  terminal: boolean;
}) {
  const seconds = input.undoAvailable
    ? runtimeConfig.cleanupStateUndoTtlSeconds
    : input.terminal
      ? runtimeConfig.cleanupStateTerminalTtlSeconds
      : runtimeConfig.cleanupStateActiveTtlSeconds;
  return input.now + seconds * 1_000;
}

export function createPrismaGmailScalableCleanupStore() {
  if (runtimeConfig.gmailScalableStoreAdapter !== "prisma") {
    throw new Error("The durable Gmail cleanup store requires GMAIL_SCALABLE_STORE_ADAPTER=prisma.");
  }
  return new PrismaGmailScalableCleanupStore();
}

export async function clearDurableGmailScalableCleanupStateForUser(userId: string) {
  if (runtimeConfig.gmailScalableStoreAdapter !== "prisma") return 0;
  return clearDurableCleanupStateForUser(userId);
}

export function clearDurableCleanupStateForUser(userId: string) {
  return deleteDurableGmailScalableCleanupStateForUser(userId, new PrismaCleanupJobStateRepository(prisma));
}

export async function clearDurableProviderCleanupStateForUser(
  userId: string,
  provider: "gmail" | "microsoft"
) {
  return (await prisma.cleanupJobState.deleteMany({
    where: { userId, job: { scan: { provider } } }
  })).count;
}

export function deleteDurableGmailScalableCleanupStateForUser(
  userId: string,
  repository: CleanupJobStateRepository
) {
  return repository.deleteForUser(userId);
}

function decodeAndValidate<TJob extends DurableCleanupJobEnvelope>(row: CleanupJobStateRow, codec: CleanupJobStateCodec<TJob>) {
  const job = (row.hydratedJob ?? codec.decode(row.encryptedPayload)) as TJob;
  if (isChunkedCleanupState(job)) throw new CleanupStateIntegrityError();
  if (job.userId !== row.userId || job.view.id !== row.jobId || job.version !== row.version) {
    throw new CleanupStateIntegrityError("Cleanup state identity or version does not match its envelope.");
  }
  return cloneJob(job);
}

function normalizeJob<TJob extends DurableCleanupJobEnvelope>(job: TJob, version: number): TJob {
  return structuredClone({ ...job, version });
}

function cloneJob<TJob extends DurableCleanupJobEnvelope>(job: TJob): TJob {
  return structuredClone(job);
}

export function verifiedCreditProgress(envelope: DurableCleanupJobEnvelope): VerifiedCreditProgress | undefined {
  if (!envelope.creditBilling) return;
  const job = envelope as (GmailScalableStoredJob | OutlookCleanupStoredJob) & DurableCleanupJobEnvelope;
  if (!job.payload.confirmedAt) return;
  const closed = ["complete", "partial", "uncertain", "failed", "expired", "undo_complete", "undoing"].includes(job.view.status);
  if ("provider" in job && job.provider === "microsoft") {
    const moved = job.payload.targets.filter((target) => target.state === "moved_verified" || target.state.startsWith("restore")).length;
    const restored = job.payload.targets.filter((target) => target.state === "restored_verified").length;
    return { requested: job.view.verification ? job.payload.targets.length : job.view.requested, moved, restored, closed };
  }
  const gmail = job as GmailScalableStoredJob;
  return { requested: gmail.view.requestedCount,
    moved: gmail.payload.chunks.reduce((sum, chunk) => sum + new Set(chunk.verifiedMovedIndexes).size, 0),
    restored: gmail.payload.chunks.reduce((sum, chunk) => sum + new Set(chunk.verifiedRestoredIndexes).size, 0), closed };
}
