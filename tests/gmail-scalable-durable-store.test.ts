import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGmailScalableChunkViews, type GmailScalableJobView } from "@/lib/domain/gmail-scalable-cleanup";
import { planGmailScalableWorkflowStep } from "@/lib/domain/gmail-scalable-workflow";
import type {
  GmailScalableCleanupProviderPort,
  GmailScalableQuotaReservation,
  GmailScalableVerificationResult
} from "@/lib/providers/gmail/scalable-cleanup-provider";
import {
  decryptCleanupStateWithKey,
  encryptCleanupStateWithKey
} from "@/lib/server/crypto";
import {
  CleanupStateIntegrityError,
  PrismaGmailScalableCleanupStore,
  cleanupStateExpiryFor,
  createCleanupJobStateCodec,
  deleteDurableGmailScalableCleanupStateForUser,
  type CleanupJobStateRepository,
  type CleanupJobStateRow
} from "@/lib/server/gmail-scalable-cleanup-durable-store";
import type { GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";
import {
  GmailScalableWorkflowCoordinator,
  type GmailScalableWorkflowOperationExecutor
} from "@/lib/server/gmail-scalable-workflow-coordinator";
import { GmailScalableProviderWorkflowExecutor } from "@/lib/server/gmail-scalable-workflow-executor";

const key = Buffer.alloc(32, 7);
const codec = createCleanupJobStateCodec({
  encrypt: (value) => encryptCleanupStateWithKey(value, key),
  decrypt: (value) => decryptCleanupStateWithKey(value, key)
});

describe("durable scalable cleanup Workflow boundary", () => {
  it("persists dispatch intent before mutation and does not duplicate it after process replacement", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const storeA = new PrismaGmailScalableCleanupStore(repository, codec);
    await storeA.create(storedJob());
    const executor = new FakeWorkflowExecutor();
    const firstProcess = new GmailScalableWorkflowCoordinator(storeA, executor, Date.now, () => "worker-a");

    expect(await firstProcess.advance("job-1", "cleanup")).toMatchObject({
      outcome: "continue",
      operation: "dispatch_trash",
      status: "verifying"
    });
    expect(executor.trashMutationCalls).toBe(1);
    expect((await storeA.getByJobId("job-1"))?.payload.chunks[0].trashMutationDispatched).toBe(true);

    const replacementProcess = new GmailScalableWorkflowCoordinator(
      new PrismaGmailScalableCleanupStore(repository, codec),
      executor,
      Date.now,
      () => "worker-b"
    );
    expect(await replacementProcess.advance("job-1", "cleanup")).toMatchObject({
      outcome: "continue",
      operation: "verify_trash",
      status: "complete",
      verifiedCount: 1
    });
    expect(executor.trashMutationCalls).toBe(1);
  });

  it("orders checkpoint, batch Trash, verification, and completion as separate durable operations", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const store = new PrismaGmailScalableCleanupStore(repository, codec);
    const job = storedJob();
    job.payload.chunks[0].historyCheckpoint = undefined;
    await store.create(job);
    const provider = new FakeDurableProvider();
    const executor = new GmailScalableProviderWorkflowExecutor(async () => provider);

    for (const owner of ["checkpoint", "dispatch", "verify", "finalize"]) {
      const coordinator = new GmailScalableWorkflowCoordinator(store, executor, Date.now, () => owner);
      await coordinator.advance("job-1", "cleanup");
    }

    expect(provider.calls).toEqual(["getProfile", "batchModify:TRASH", "history.list:labelAdded"]);
    expect(provider.trashMutations).toBe(1);
    expect(await store.getByJobId("job-1")).toMatchObject({
      view: { status: "complete", verifiedCount: 1, undoAvailable: true }
    });
  });

  it("returns durable sleep semantics for quota pauses without invoking a provider operation", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const store = new PrismaGmailScalableCleanupStore(repository, codec);
    const job = storedJob();
    job.view.status = "paused";
    job.view.nextEligibleRunAt = Date.now() + 60_000;
    await store.create(job);
    const executor = new FakeWorkflowExecutor();

    expect(await new GmailScalableWorkflowCoordinator(store, executor).advance("job-1", "cleanup"))
      .toMatchObject({ outcome: "sleep", resumeAt: job.view.nextEligibleRunAt });
    expect(executor.operations).toHaveLength(0);
  });

  it("restores the persisted resume state before executing work after a quota pause", async () => {
    const job = storedJob();
    job.view.status = "paused";
    job.view.nextEligibleRunAt = Date.now() - 1;
    job.view.verifiedCount = 1;
    job.view.chunks[0].status = "complete";
    job.view.chunks[0].safeCount = 1;
    job.view.chunks[0].attemptedCount = 1;
    job.view.chunks[0].verifiedCount = 1;
    job.payload.resumeState = "undoing";
    job.payload.chunks[0].verifiedMovedIndexes = [0];
    const provider = new FakeDurableProvider();
    const executor = new GmailScalableProviderWorkflowExecutor(async () => provider);

    const resumed = await executor.execute({ job, operation: "checkpoint_undo" });

    expect(resumed.view.status).toBe("undoing");
    expect(resumed.view.nextEligibleRunAt).toBeUndefined();
    expect(resumed.payload.resumeState).toBeUndefined();
    expect(resumed.payload.chunks[0].undoHistoryCheckpoint).toBe("history-before-mutation");
    expect(provider.calls).toEqual(["getProfile"]);
  });

  it("stops safely when encrypted transient state is missing", async () => {
    const coordinator = new GmailScalableWorkflowCoordinator(
      new PrismaGmailScalableCleanupStore(new FakeCleanupJobStateRepository(), codec),
      new FakeWorkflowExecutor()
    );
    expect(await coordinator.advance("missing-job", "cleanup")).toEqual({ outcome: "stop", reason: "missing_state" });
  });

  it("models 500, 1,000, and 5,000 targets as 250-message chunks", () => {
    expect(createGmailScalableChunkViews(500)).toHaveLength(2);
    expect(createGmailScalableChunkViews(1_000)).toHaveLength(4);
    expect(createGmailScalableChunkViews(5_000)).toHaveLength(20);
  });

  it("keeps Workflow function input and start arguments to one opaque job ID", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), "src/workflows/gmail-scalable-cleanup.ts"), "utf8");
    const starter = fs.readFileSync(path.join(process.cwd(), "src/lib/server/gmail-scalable-workflow-start.ts"), "utf8");
    expect(workflow).toMatch(/gmailScalableCleanupWorkflow\(cleanupJobId: string\)/);
    expect(starter).toMatch(/start\(gmailScalableCleanupWorkflow, \[cleanupJobId\]\)/);
    expect(starter).toMatch(/start\(gmailScalableUndoWorkflow, \[cleanupJobId\]\)/);
    expect(starter).not.toMatch(/start\([^\n]+\[(?:[^\]]*apiMessageId|[^\]]*uidValidity|[^\]]*historyCheckpoint)/);
    expect(workflow).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(workflow).toContain("The Gmail cleanup step could not be completed safely.");
  });

  it("routes dispatched Undo directly to verification rather than another mutation", () => {
    const job = storedJob();
    job.view.status = "undoing";
    job.payload.chunks[0].verifiedMovedIndexes = [0];
    job.payload.chunks[0].undoHistoryCheckpoint = "undo-history-1";
    job.payload.chunks[0].undoMutationDispatched = true;
    expect(planGmailScalableWorkflowStep(job, "undo")).toEqual({ outcome: "run", operation: "verify_undo" });
  });
});

describe("Prisma scalable cleanup transient store", () => {
  it("round-trips one application-encrypted job payload without storing plaintext Gmail IDs", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const store = new PrismaGmailScalableCleanupStore(repository, codec);
    await store.create(storedJob());

    expect(repository.rows.size).toBe(1);
    const row = repository.rows.get("job-1");
    expect(row?.encryptedPayload).not.toContain("gmail-api-id-1");
    expect(row?.encryptedPayload).not.toContain("uidValidity");
    expect(row?.encryptedPayload).not.toContain("history-1");
    expect(await store.get("user-1", "job-1")).toEqual(expect.objectContaining({
      userId: "user-1",
      payload: expect.objectContaining({ uidValidity: "77" })
    }));
  });

  it("uses atomic create and version-based compare-and-set", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const store = new PrismaGmailScalableCleanupStore(repository, codec);
    const created = await store.create(storedJob());
    await expect(store.create(storedJob())).rejects.toThrow(/already exists/);
    expect(await store.compareAndSet("user-1", "job-1", 99, (job) => job)).toBeUndefined();
    const updated = await store.compareAndSet("user-1", "job-1", created.version, (job) => {
      job.view.duplicateStartCount += 1;
      return job;
    });
    expect(updated?.version).toBe(2);
    expect((await store.get("user-1", "job-1"))?.view.duplicateStartCount).toBe(1);
  });

  it("binds Workflow compare-and-set to a still-valid lock owner", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const store = new PrismaGmailScalableCleanupStore(repository, codec);
    const created = await store.create(storedJob());
    const now = new Date();
    await store.claim("job-1", "worker-a", now, 10_000);

    expect(await store.compareAndSet(
      "user-1",
      "job-1",
      created.version,
      (job) => job,
      new Date(now.getTime() + 1_000),
      "worker-b"
    )).toBeUndefined();
    expect(await store.compareAndSet(
      "user-1",
      "job-1",
      created.version,
      (job) => job,
      new Date(now.getTime() + 10_001),
      "worker-a"
    )).toBeUndefined();
  });

  it("allows one lock owner and permits reclaim only after lock expiry", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const store = new PrismaGmailScalableCleanupStore(repository, codec);
    await store.create(storedJob());
    const now = new Date("2026-08-28T12:00:00.000Z");

    expect(await store.claim("job-1", "worker-a", now, 10_000)).toBeDefined();
    expect(await store.claim("job-1", "worker-b", new Date(now.getTime() + 9_999), 10_000)).toBeUndefined();
    expect(await store.refreshLock("job-1", "worker-b", now, 10_000)).toBe(false);
    expect(await store.refreshLock("job-1", "worker-a", new Date(now.getTime() + 1_000), 20_000)).toBe(true);
    expect(await store.claim("job-1", "worker-b", new Date(now.getTime() + 21_001), 10_000)).toBeDefined();
    expect(await store.releaseLock("job-1", "worker-a")).toBe(false);
    expect(await store.releaseLock("job-1", "worker-b")).toBe(true);
  });

  it("fails closed and removes state after expiresAt", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const store = new PrismaGmailScalableCleanupStore(repository, codec);
    const job = storedJob();
    job.view.expiresAt = Date.parse("2026-08-28T12:00:00.000Z");
    await store.create(job);

    expect(await store.getByJobId("job-1", new Date("2026-08-28T12:00:00.001Z"))).toBeUndefined();
    expect(repository.rows.size).toBe(0);
    expect(await store.claim("job-1", "worker", new Date("2026-08-28T12:00:01.000Z"))).toBeUndefined();
  });

  it("fails closed on malformed or unauthenticated ciphertext", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const store = new PrismaGmailScalableCleanupStore(repository, codec);
    await store.create(storedJob());
    repository.rows.get("job-1")!.encryptedPayload = "not-authenticated-ciphertext";
    await expect(store.getByJobId("job-1")).rejects.toBeInstanceOf(CleanupStateIntegrityError);
  });

  it("survives store/process replacement through the shared durable row", async () => {
    const repository = new FakeCleanupJobStateRepository();
    await new PrismaGmailScalableCleanupStore(repository, codec).create(storedJob());
    const replacementProcessStore = new PrismaGmailScalableCleanupStore(repository, codec);
    expect((await replacementProcessStore.getByJobId("job-1"))?.payload.chunks[0].targets[0].apiMessageId)
      .toBe("gmail-api-id-1");
  });

  it("deletes every transient row for the user on the Disconnect cleanup primitive", async () => {
    const repository = new FakeCleanupJobStateRepository();
    const store = new PrismaGmailScalableCleanupStore(repository, codec);
    await store.create(storedJob());
    const second = storedJob("job-2", "user-1");
    await store.create(second);
    await store.create(storedJob("job-3", "user-2"));

    expect(await deleteDurableGmailScalableCleanupStateForUser("user-1", repository)).toBe(2);
    expect([...repository.rows.values()].map((row) => row.userId)).toEqual(["user-2"]);
  });

  it("uses centrally bounded active, Undo, and terminal expiry policies", () => {
    const now = Date.now();
    expect(cleanupStateExpiryFor({ now, undoAvailable: false, terminal: false })).toBeGreaterThan(now);
    expect(cleanupStateExpiryFor({ now, undoAvailable: true, terminal: true })).toBeGreaterThan(now);
    expect(cleanupStateExpiryFor({ now, undoAvailable: false, terminal: true })).toBeGreaterThan(now);
  });

  it("keeps one payload row per job and aggregate Prisma state mailbox-metadata-free", () => {
    const schema = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const stateModel = schema.match(/model CleanupJobState \{[\s\S]*?\n\}/)?.[0] ?? "";
    const aggregateModel = schema.match(/model CleanupJob \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(stateModel).toContain("encryptedPayload String");
    expect(stateModel).not.toMatch(/Gmail|Imap|UidValidity|History|Subject|Header|MessageId/);
    expect(aggregateModel).not.toMatch(/Gmail|Imap|UidValidity|History|Subject|Header|MessageId/);
    expect(schema.match(/model CleanupJobState/g)).toHaveLength(1);
  });
});

export class FakeCleanupJobStateRepository implements CleanupJobStateRepository {
  readonly rows = new Map<string, CleanupJobStateRow>();

  async create(row: Omit<CleanupJobStateRow, "createdAt" | "updatedAt">) {
    if (this.rows.has(row.jobId)) throw new Error("Cleanup state already exists.");
    const now = new Date();
    const stored = cloneRow({ ...row, createdAt: now, updatedAt: now });
    this.rows.set(row.jobId, stored);
    return cloneRow(stored);
  }

  async find(jobId: string) {
    const row = this.rows.get(jobId);
    return row ? cloneRow(row) : null;
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
    const row = this.rows.get(input.jobId);
    if (
      !row ||
      row.userId !== input.userId ||
      row.version !== input.expectedVersion ||
      row.expiresAt <= input.now ||
      (input.lockOwner && (
        row.lockOwner !== input.lockOwner ||
        !row.lockExpiresAt ||
        row.lockExpiresAt <= input.now
      ))
    ) return false;
    row.encryptedPayload = input.encryptedPayload;
    row.expiresAt = new Date(input.expiresAt);
    row.version += 1;
    row.updatedAt = new Date(input.now);
    return true;
  }

  async claim(input: { jobId: string; owner: string; now: Date; lockExpiresAt: Date }) {
    const row = this.rows.get(input.jobId);
    if (!row || row.expiresAt <= input.now) return false;
    if (row.lockOwner && row.lockExpiresAt && row.lockExpiresAt > input.now) return false;
    row.lockOwner = input.owner;
    row.lockExpiresAt = new Date(input.lockExpiresAt);
    return true;
  }

  async refreshLock(input: { jobId: string; owner: string; now: Date; lockExpiresAt: Date }) {
    const row = this.rows.get(input.jobId);
    if (!row || row.lockOwner !== input.owner || !row.lockExpiresAt || row.lockExpiresAt <= input.now || row.expiresAt <= input.now) {
      return false;
    }
    row.lockExpiresAt = new Date(input.lockExpiresAt);
    return true;
  }

  async releaseLock(jobId: string, owner: string) {
    const row = this.rows.get(jobId);
    if (!row || row.lockOwner !== owner) return false;
    row.lockOwner = null;
    row.lockExpiresAt = null;
    return true;
  }

  async delete(jobId: string, userId?: string) {
    const row = this.rows.get(jobId);
    return row && (!userId || row.userId === userId) ? this.rows.delete(jobId) : false;
  }

  async deleteForUser(userId: string) {
    let count = 0;
    for (const [jobId, row] of this.rows) {
      if (row.userId === userId && this.rows.delete(jobId)) count += 1;
    }
    return count;
  }

  async deleteExpired(now: Date) {
    let count = 0;
    for (const [jobId, row] of this.rows) {
      if (row.expiresAt <= now && this.rows.delete(jobId)) count += 1;
    }
    return count;
  }
}

export function storedJob(jobId = "job-1", userId = "user-1"): GmailScalableStoredJob {
  const now = Date.now();
  const chunks = createGmailScalableChunkViews(1);
  chunks[0].status = "mutating";
  const view: GmailScalableJobView = {
    id: jobId,
    status: "mutating",
    requestedCount: 1,
    chunkSize: 250,
    chunkCount: 1,
    safeCount: 1,
    excludedCount: 0,
    attemptedCount: 0,
    verifiedCount: 0,
    failedCount: 0,
    uncertainCount: 0,
    verifiedRestoredCount: 0,
    failedRestoreCount: 0,
    uncertainRestoreCount: 0,
    verifiedProcessedCount: 0,
    progressLabel: "Moving 1 message to Trash...",
    quotaConsumedUnits: 0,
    developmentAuditQuotaUnits: 0,
    quotaWorkingLimit: 4_500,
    suggestedDeltas: [],
    groupIndices: [0],
    chunks,
    undoAvailable: false,
    duplicateStartCount: 0,
    duplicateDispatchCount: 0,
    duplicateUndoCount: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 30 * 60 * 1_000
  };
  return {
    userId,
    acceptanceKey: `accept-${jobId}`,
    version: 0,
    view,
    payload: {
      scanId: "scan-1",
      uidValidity: "77",
      chunks: [{
        index: 0,
        targets: [{
          uid: 1,
          apiMessageId: "gmail-api-id-1",
          groupIndex: 0,
          immutableEvidence: {
            eligibleAtScan: true,
            subjectProtected: false,
            participatedConversation: false,
            protectedAtScan: false,
            ageBand: "very_old",
            cleanupSignals: ["HAS_LIST_ID"]
          }
        }],
        safeTargetIndexes: [0],
        verifiedMovedIndexes: [],
        verifiedRestoredIndexes: [],
        historyCheckpoint: "history-1"
      }],
      quotaWindow: { startedAt: now, consumedUnits: 0 }
    }
  };
}

function cloneRow(row: CleanupJobStateRow): CleanupJobStateRow {
  return structuredClone(row);
}

class FakeWorkflowExecutor implements GmailScalableWorkflowOperationExecutor {
  readonly operations: string[] = [];
  trashMutationCalls = 0;

  async execute(input: Parameters<GmailScalableWorkflowOperationExecutor["execute"]>[0]) {
    this.operations.push(input.operation);
    const job = structuredClone(input.job);
    if (input.operation === "dispatch_trash") {
      this.trashMutationCalls += 1;
      job.view.status = "verifying";
      job.view.chunks[0].status = "verifying";
      job.view.chunks[0].attemptedCount = 1;
    } else if (input.operation === "verify_trash") {
      job.view.status = "complete";
      job.view.chunks[0].status = "complete";
      job.view.chunks[0].attemptedCount = 1;
      job.view.chunks[0].verifiedCount = 1;
      job.view.attemptedCount = 1;
      job.view.verifiedCount = 1;
      job.view.verifiedProcessedCount = 1;
      job.view.undoAvailable = true;
      job.payload.chunks[0].verifiedMovedIndexes = [0];
    }
    return job;
  }
}

class FakeDurableProvider implements GmailScalableCleanupProviderPort {
  readonly calls: string[] = [];
  trashMutations = 0;

  async runSafetyCheck(): Promise<never> {
    throw new Error("Safety is not part of this fixture state.");
  }

  async captureHistoryCheckpoint(reserve: GmailScalableQuotaReservation) {
    await reserve("getProfile");
    this.calls.push("getProfile");
    return "history-before-mutation";
  }

  async moveToTrash(_ids: readonly string[], reserve: GmailScalableQuotaReservation) {
    await reserve("batchModify");
    this.calls.push("batchModify:TRASH");
    this.trashMutations += 1;
  }

  async verifyTrash(input: { targetIds: readonly string[]; reserve: GmailScalableQuotaReservation }) {
    await input.reserve("historyList");
    this.calls.push("history.list:labelAdded");
    return verifiedResult(input.targetIds);
  }

  async removeTrashLabel(): Promise<never> {
    throw new Error("Undo is not part of this fixture state.");
  }

  async verifyTrashRemoval(): Promise<never> {
    throw new Error("Undo is not part of this fixture state.");
  }

  async auditTrashPostState(): Promise<never> {
    throw new Error("The development audit is disabled in durable execution.");
  }
}

function verifiedResult(ids: readonly string[]): GmailScalableVerificationResult {
  return {
    verifiedIds: [...ids],
    failedIds: [],
    uncertainIds: [],
    historyVerifiedCount: ids.length,
    listVerifiedCount: 0,
    getVerifiedCount: 0,
    historyRequests: 1,
    historyPages: 1,
    historyPollAttempts: 1,
    listRequests: 0,
    listPages: 0,
    getFallbackRequests: 0,
    retryCount: 0,
    historyUnavailable: false,
    durationMs: 1
  };
}
