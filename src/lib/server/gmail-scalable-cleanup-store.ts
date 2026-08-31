import "server-only";
import { decryptCleanupState, encryptCleanupState } from "@/lib/server/crypto";
import type {
  GmailScalableChunkView,
  GmailScalableJobView,
  GmailScalableRestoreMode
} from "@/lib/domain/gmail-scalable-cleanup";
import { getGmailScalableJobProgress } from "@/lib/domain/gmail-scalable-cleanup";
import type { GmailScalableCleanupTarget } from "@/lib/providers/gmail/scalable-targets";

export type GmailScalableSensitiveChunk = {
  index: number;
  targets: GmailScalableCleanupTarget[];
  preflightComplete?: boolean;
  safeTargetIndexes: number[];
  verifiedMovedIndexes: number[];
  verifiedRestoredIndexes: number[];
  historyCheckpoint?: string;
  trashMutationDispatched?: boolean;
  undoHistoryCheckpoint?: string;
  undoMutationDispatched?: boolean;
};

export type GmailScalableSensitivePayload = {
  scanId: string;
  uidValidity: string;
  chunks: GmailScalableSensitiveChunk[];
  quotaWindow: {
    startedAt: number;
    consumedUnits: number;
  };
  resumeState?: "safety_checking" | "mutating" | "verifying" | "undoing";
  confirmedAt?: number;
  undoQuotaStartUnits?: number;
  fixture?: GmailScalableFixtureControl;
};

export type GmailScalableFixtureControl = {
  enabled: true;
  autoConfirm: boolean;
  mutationOutcome: "applied" | "not_applied" | "uncertain";
  mutationOutcomesByChunk: Array<"applied" | "not_applied" | "uncertain">;
  preflightSafetyExcludedCountsByChunk: number[];
  safetyExcludedCountsByChunk: number[];
  interruptAfterTrashDispatchChunkIndexes: number[];
  quotaPauseBeforeCleanupChunkIndexes: number[];
  quotaPauseBeforeUndoChunkIndexes: number[];
  consumedCleanupQuotaPauses: number[];
  consumedUndoQuotaPauses: number[];
  operationLedger: Array<{
    operation: "preflight_safety" | "safety" | "checkpoint_trash" | "dispatch_trash" | "verify_trash" | "checkpoint_undo" | "dispatch_undo" | "verify_undo";
    chunkIndex: number;
  }>;
  verifiedProgress: number[];
  restoredProgress: number[];
};

export type GmailScalableStoredJob = {
  userId: string;
  acceptanceKey: string;
  version: number;
  view: GmailScalableJobView;
  payload: GmailScalableSensitivePayload;
};

type EncryptedStoredJob = Omit<GmailScalableStoredJob, "payload"> & {
  encryptedPayload: string;
};

export type GmailScalablePayloadCodec = {
  encode(payload: GmailScalableSensitivePayload): string;
  decode(value: string): GmailScalableSensitivePayload;
};

export interface GmailScalableCleanupStore {
  create(job: GmailScalableStoredJob): GmailScalableStoredJob;
  get(userId: string, jobId: string): GmailScalableStoredJob | undefined;
  findActive(userId: string, acceptanceKey: string): GmailScalableStoredJob | undefined;
  findLatest(userId: string): GmailScalableStoredJob | undefined;
  compareAndSet(
    userId: string,
    jobId: string,
    expectedVersion: number,
    update: (job: GmailScalableStoredJob) => GmailScalableStoredJob
  ): GmailScalableStoredJob | undefined;
  delete(userId: string, jobId: string): boolean;
  deleteForUser(userId: string): number;
  purgeExpired(now?: number): number;
}

const terminalStatuses = new Set(["complete", "partial", "uncertain", "failed", "undo_complete", "expired"]);

export class InMemoryGmailScalableCleanupStore implements GmailScalableCleanupStore {
  private readonly jobs = new Map<string, EncryptedStoredJob>();

  constructor(private readonly codec: GmailScalablePayloadCodec = createEncryptedJsonCodec()) {}

  create(job: GmailScalableStoredJob) {
    this.purgeExpired();
    if (this.jobs.has(job.view.id)) throw new Error("Scalable cleanup job already exists.");
    const stored = normalizeStoredJob(job, 1);
    this.jobs.set(job.view.id, this.encrypt(stored));
    return cloneStoredJob(stored);
  }

  get(userId: string, jobId: string) {
    const encrypted = this.jobs.get(jobId);
    if (!encrypted || encrypted.userId !== userId) return undefined;
    if (encrypted.view.expiresAt <= Date.now()) {
      this.jobs.delete(jobId);
      return undefined;
    }
    return this.decrypt(encrypted);
  }

  findActive(userId: string, acceptanceKey: string) {
    this.purgeExpired();
    for (const encrypted of this.jobs.values()) {
      if (
        encrypted.userId === userId &&
        encrypted.acceptanceKey === acceptanceKey &&
        !terminalStatuses.has(encrypted.view.status)
      ) {
        return this.decrypt(encrypted);
      }
    }
    return undefined;
  }

  findLatest(userId: string) {
    this.purgeExpired();
    let latest: EncryptedStoredJob | undefined;
    for (const job of this.jobs.values()) {
      if (job.userId === userId && (!latest || job.view.updatedAt > latest.view.updatedAt)) latest = job;
    }
    return latest ? this.decrypt(latest) : undefined;
  }

  compareAndSet(
    userId: string,
    jobId: string,
    expectedVersion: number,
    update: (job: GmailScalableStoredJob) => GmailScalableStoredJob
  ) {
    const current = this.get(userId, jobId);
    if (!current || current.version !== expectedVersion) return undefined;
    const next = normalizeStoredJob(update(cloneStoredJob(current)), expectedVersion + 1);
    if (next.userId !== userId || next.view.id !== jobId) throw new Error("Scalable cleanup identity cannot change.");
    this.jobs.set(jobId, this.encrypt(next));
    return cloneStoredJob(next);
  }

  delete(userId: string, jobId: string) {
    const current = this.jobs.get(jobId);
    return current?.userId === userId ? this.jobs.delete(jobId) : false;
  }

  deleteForUser(userId: string) {
    let deleted = 0;
    for (const [jobId, job] of this.jobs) {
      if (job.userId === userId && this.jobs.delete(jobId)) deleted += 1;
    }
    return deleted;
  }

  purgeExpired(now = Date.now()) {
    let deleted = 0;
    for (const [jobId, job] of this.jobs) {
      if (job.view.expiresAt <= now && this.jobs.delete(jobId)) deleted += 1;
    }
    return deleted;
  }

  private encrypt(job: GmailScalableStoredJob): EncryptedStoredJob {
    const { payload, ...aggregate } = job;
    return { ...cloneAggregate(aggregate), encryptedPayload: this.codec.encode(payload) };
  }

  private decrypt(job: EncryptedStoredJob): GmailScalableStoredJob {
    const { encryptedPayload, ...aggregate } = job;
    return { ...cloneAggregate(aggregate), payload: this.codec.decode(encryptedPayload) };
  }
}

const globalStore = globalThis as unknown as {
  organizinboxScalableCleanupStore?: InMemoryGmailScalableCleanupStore;
};

export const gmailScalableCleanupStore =
  globalStore.organizinboxScalableCleanupStore ?? new InMemoryGmailScalableCleanupStore();
globalStore.organizinboxScalableCleanupStore = gmailScalableCleanupStore;

export function clearGmailScalableCleanupJobsForUser(userId: string) {
  return gmailScalableCleanupStore.deleteForUser(userId);
}

export function serializeGmailScalableJob(job: GmailScalableStoredJob | GmailScalableJobView) {
  const view = "view" in job ? job.view : job;
  const progress = getGmailScalableJobProgress(view);
  if (!("view" in job)) return structuredClone({ ...view, ...progress });
  const recovery = getGmailScalableRestoreEligibility(job);
  return structuredClone({
    ...view,
    ...progress,
    recoveryRestoreAvailable: recovery.available && recovery.mode === "recovery",
    recoveryRestoreCount: exactVerifiedMovedLedgerCount(job),
    recoveryRestoreReason: recovery.reason
  });
}

const recoveryRestoreStatuses = new Set(["chunk_complete", "paused", "partial", "uncertain", "failed"]);

export type GmailScalableRestoreEligibility = {
  available: boolean;
  mode?: GmailScalableRestoreMode;
  count: number;
  reason: string;
};

export function getGmailScalableRestoreEligibility(job: GmailScalableStoredJob): GmailScalableRestoreEligibility {
  const exactCount = exactVerifiedMovedLedgerCount(job);
  if (job.view.status === "complete") {
    const available = job.view.undoAvailable && hasCompleteExactVerifiedMovedLedger(job);
    return {
      available,
      mode: available ? "undo" : undefined,
      count: available ? exactCount : 0,
      reason: available
        ? "The complete job has an exact verified-move ledger for normal Undo."
        : "The complete job is not eligible for normal Undo."
    };
  }
  if (job.view.restoreMode || job.view.status === "undoing") {
    return { available: false, count: 0, reason: "A restore is already in progress or awaiting reconciliation." };
  }
  if (!recoveryRestoreStatuses.has(job.view.status)) {
    return { available: false, count: 0, reason: "The current state is not an interrupted cleanup recovery state." };
  }
  const count = exactRecoverableVerifiedMovedLedgerCount(job);
  return {
    available: count > 0,
    mode: count > 0 ? "recovery" : undefined,
    count,
    reason: count > 0
      ? `Only ${count} exact authoritatively verified moved messages are recoverable.`
      : exactCount > 0
        ? "The exact moved ledger requires provider reconciliation before another restore attempt."
        : "No exact authoritatively verified moved messages are available to restore."
  };
}

export function exactVerifiedMovedLedgerCount(job: GmailScalableStoredJob) {
  let total = 0;
  for (const chunk of job.payload.chunks) {
    const indexes = validUniqueIndexes(chunk.verifiedMovedIndexes, chunk.targets.length);
    const safe = validUniqueIndexes(chunk.safeTargetIndexes, chunk.targets.length);
    if (!indexes || !safe || [...indexes].some((index) => !safe.has(index))) return 0;
    total += indexes.size;
  }
  return total;
}

export function exactRecoverableVerifiedMovedLedgerCount(job: GmailScalableStoredJob) {
  let total = 0;
  for (const chunk of job.payload.chunks) {
    const moved = validUniqueIndexes(chunk.verifiedMovedIndexes, chunk.targets.length);
    const restored = validUniqueIndexes(chunk.verifiedRestoredIndexes, chunk.targets.length);
    const safe = validUniqueIndexes(chunk.safeTargetIndexes, chunk.targets.length);
    if (!moved || !restored || !safe || [...moved].some((index) => !safe.has(index)) || [...restored].some((index) => !moved.has(index))) return 0;
    if (!chunk.undoMutationDispatched && restored.size === 0) total += moved.size;
  }
  return total;
}

export function hasCompleteExactVerifiedMovedLedger(job: GmailScalableStoredJob) {
  if (
    job.view.attemptedCount <= 0 ||
    job.view.requestedCount !== job.view.excludedCount + job.view.attemptedCount ||
    job.view.verifiedCount !== job.view.attemptedCount ||
    job.view.failedCount !== 0 ||
    job.view.uncertainCount !== 0
  ) return false;
  return job.payload.chunks.every((sensitive) => {
    const chunk = job.view.chunks[sensitive.index];
    if (!chunk) return false;
    const safe = validUniqueIndexes(sensitive.safeTargetIndexes, sensitive.targets.length);
    const verified = validUniqueIndexes(sensitive.verifiedMovedIndexes, sensitive.targets.length);
    if (!safe || !verified) return false;
    return chunk.attemptedCount === chunk.verifiedCount &&
      chunk.failedCount === 0 &&
      chunk.uncertainCount === 0 &&
      safe.size === chunk.safeCount &&
      chunk.safeCount === chunk.attemptedCount &&
      verified.size === chunk.attemptedCount &&
      sensitive.verifiedMovedIndexes.length === verified.size &&
      [...verified].every((index) => safe.has(index));
  });
}

function validUniqueIndexes(indexes: readonly number[], targetCount: number) {
  const unique = new Set(indexes);
  if (unique.size !== indexes.length || [...unique].some((index) => !Number.isInteger(index) || index < 0 || index >= targetCount)) {
    return undefined;
  }
  return unique;
}

function createEncryptedJsonCodec(): GmailScalablePayloadCodec {
  return {
    encode(payload) {
      return encryptCleanupState(JSON.stringify(payload));
    },
    decode(value) {
      return JSON.parse(decryptCleanupState(value)) as GmailScalableSensitivePayload;
    }
  };
}

function normalizeStoredJob(job: GmailScalableStoredJob, version: number): GmailScalableStoredJob {
  return {
    ...job,
    version,
    view: {
      ...job.view,
      updatedAt: Date.now(),
      chunks: job.view.chunks.map(normalizeChunk)
    },
    payload: structuredClone(job.payload)
  };
}

function normalizeChunk(chunk: GmailScalableChunkView) {
  return { ...chunk };
}

function cloneStoredJob(job: GmailScalableStoredJob): GmailScalableStoredJob {
  return structuredClone(job);
}

function cloneAggregate<T extends Omit<GmailScalableStoredJob, "payload">>(job: T): T {
  return structuredClone(job);
}
