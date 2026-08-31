import "server-only";
import type { CleanupJobState, PrismaClient } from "@prisma/client";
import { runtimeConfig } from "@/lib/config";
import {
  decryptCleanupState,
  encryptCleanupState
} from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import type { GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";

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
>;

export type CleanupJobStateCodec = {
  encode(job: GmailScalableStoredJob): string;
  decode(value: string): GmailScalableStoredJob;
};

export type CleanupJobStateRepository = {
  create(row: Omit<CleanupJobStateRow, "createdAt" | "updatedAt">): Promise<CleanupJobStateRow>;
  find(jobId: string): Promise<CleanupJobStateRow | null>;
  replaceIfVersion(input: {
    jobId: string;
    userId: string;
    expectedVersion: number;
    now: Date;
    lockOwner?: string;
    encryptedPayload: string;
    expiresAt: Date;
  }): Promise<boolean>;
  claim(input: { jobId: string; owner: string; now: Date; lockExpiresAt: Date }): Promise<boolean>;
  refreshLock(input: { jobId: string; owner: string; now: Date; lockExpiresAt: Date }): Promise<boolean>;
  releaseLock(jobId: string, owner: string): Promise<boolean>;
  delete(jobId: string, userId?: string): Promise<boolean>;
  deleteForUser(userId: string): Promise<number>;
  deleteExpired(now: Date): Promise<number>;
};

export interface GmailScalableDurableCleanupStore {
  create(job: GmailScalableStoredJob): Promise<GmailScalableStoredJob>;
  get(userId: string, jobId: string, now?: Date): Promise<GmailScalableStoredJob | undefined>;
  getByJobId(jobId: string, now?: Date): Promise<GmailScalableStoredJob | undefined>;
  compareAndSet(
    userId: string,
    jobId: string,
    expectedVersion: number,
    update: (job: GmailScalableStoredJob) => GmailScalableStoredJob,
    now?: Date,
    lockOwner?: string
  ): Promise<GmailScalableStoredJob | undefined>;
  claim(jobId: string, owner: string, now?: Date, ttlMs?: number): Promise<GmailScalableStoredJob | undefined>;
  refreshLock(jobId: string, owner: string, now?: Date, ttlMs?: number): Promise<boolean>;
  releaseLock(jobId: string, owner: string): Promise<boolean>;
  delete(userId: string, jobId: string): Promise<boolean>;
  deleteForUser(userId: string): Promise<number>;
  purgeExpired(now?: Date): Promise<number>;
}

export class PrismaGmailScalableCleanupStore implements GmailScalableDurableCleanupStore {
  constructor(
    private readonly repository: CleanupJobStateRepository = new PrismaCleanupJobStateRepository(prisma),
    private readonly codec: CleanupJobStateCodec = createCleanupJobStateCodec()
  ) {}

  async create(job: GmailScalableStoredJob) {
    const stored = normalizeJob(job, 1);
    await this.repository.create({
      jobId: stored.view.id,
      userId: stored.userId,
      encryptedPayload: this.codec.encode(stored),
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
    const row = await this.repository.find(jobId);
    if (!row) return undefined;
    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.repository.delete(jobId);
      return undefined;
    }
    return decodeAndValidate(row, this.codec);
  }

  async compareAndSet(
    userId: string,
    jobId: string,
    expectedVersion: number,
    update: (job: GmailScalableStoredJob) => GmailScalableStoredJob,
    now = new Date(),
    lockOwner?: string
  ) {
    const row = await this.repository.find(jobId);
    if (!row || row.userId !== userId || row.version !== expectedVersion) return undefined;
    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.repository.delete(jobId, userId);
      return undefined;
    }
    const current = decodeAndValidate(row, this.codec);
    const next = normalizeJob(update(cloneJob(current)), expectedVersion + 1);
    if (next.userId !== userId || next.view.id !== jobId) {
      throw new CleanupStateIntegrityError("Cleanup state identity cannot change.");
    }
    if (next.view.expiresAt <= now.getTime()) return undefined;
    const replaced = await this.repository.replaceIfVersion({
      jobId,
      userId,
      expectedVersion,
      now,
      lockOwner,
      encryptedPayload: this.codec.encode(next),
      expiresAt: new Date(next.view.expiresAt)
    });
    return replaced ? cloneJob(next) : undefined;
  }

  async claim(
    jobId: string,
    owner: string,
    now = new Date(),
    ttlMs = runtimeConfig.cleanupStateLockTtlSeconds * 1_000
  ) {
    if (!owner) throw new Error("Cleanup state lock owner is required.");
    const claimed = await this.repository.claim({
      jobId,
      owner,
      now,
      lockExpiresAt: new Date(now.getTime() + ttlMs)
    });
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
    return this.repository.releaseLock(jobId, owner);
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

export class PrismaCleanupJobStateRepository implements CleanupJobStateRepository {
  constructor(private readonly client: PrismaClient) {}

  create(row: Omit<CleanupJobStateRow, "createdAt" | "updatedAt">) {
    return this.client.cleanupJobState.create({ data: row });
  }

  find(jobId: string) {
    return this.client.cleanupJobState.findUnique({ where: { jobId } });
  }

  async replaceIfVersion(input: {
    jobId: string;
    userId: string;
    expectedVersion: number;
    now: Date;
    lockOwner?: string;
    encryptedPayload: string;
    expiresAt: Date;
  }) {
    const result = await this.client.$transaction((transaction) =>
      transaction.cleanupJobState.updateMany({
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
      }),
      { isolationLevel: "Serializable" }
    );
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

  async deleteExpired(now: Date) {
    return (await this.client.cleanupJobState.deleteMany({ where: { expiresAt: { lte: now } } })).count;
  }
}

export class CleanupStateIntegrityError extends Error {
  constructor(message = "Cleanup state could not be authenticated.") {
    super(message);
    this.name = "CleanupStateIntegrityError";
  }
}

export function createCleanupJobStateCodec(input?: {
  encrypt(value: string): string;
  decrypt(value: string): string;
}): CleanupJobStateCodec {
  const crypto = input ?? { encrypt: encryptCleanupState, decrypt: decryptCleanupState };
  return {
    encode(job) {
      return crypto.encrypt(JSON.stringify(job));
    },
    decode(value) {
      try {
        return JSON.parse(crypto.decrypt(value)) as GmailScalableStoredJob;
      } catch {
        throw new CleanupStateIntegrityError();
      }
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
  return deleteDurableGmailScalableCleanupStateForUser(
    userId,
    new PrismaCleanupJobStateRepository(prisma)
  );
}

export function deleteDurableGmailScalableCleanupStateForUser(
  userId: string,
  repository: CleanupJobStateRepository
) {
  return repository.deleteForUser(userId);
}

function decodeAndValidate(row: CleanupJobStateRow, codec: CleanupJobStateCodec) {
  const job = codec.decode(row.encryptedPayload);
  if (job.userId !== row.userId || job.view.id !== row.jobId || job.version !== row.version) {
    throw new CleanupStateIntegrityError("Cleanup state identity or version does not match its envelope.");
  }
  return cloneJob(job);
}

function normalizeJob(job: GmailScalableStoredJob, version: number): GmailScalableStoredJob {
  return structuredClone({ ...job, version });
}

function cloneJob(job: GmailScalableStoredJob) {
  return structuredClone(job);
}
