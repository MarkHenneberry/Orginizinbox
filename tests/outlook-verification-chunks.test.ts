import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrismaCleanupJobStore, createCleanupJobStateCodec, type CleanupJobStateRepository, type CleanupJobStateRow } from "@/lib/server/cleanup-job-store";
import { encryptCleanupStateWithKey, decryptCleanupStateWithKey } from "@/lib/server/crypto";
import { createEmptyOutlookCleanupTiming } from "@/lib/domain/outlook-cleanup";
import type { OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";
import { advanceOutlookCleanupJob, prepareOutlookJob } from "@/lib/server/outlook-cleanup";
import { newVerificationTrace, type VerificationTrace } from "@/lib/server/outlook-verification-timing";
import { providerCleanupWorkflow, runProviderCleanupStep } from "@/workflows/provider-cleanup";

type Coordinate = <T>(request: () => Promise<T>) => Promise<T>;
const h = vi.hoisted(() => ({
  row: undefined as CleanupJobStateRow | undefined,
  store: undefined as PrismaCleanupJobStore<OutlookCleanupStoredJob> | undefined,
  reads: [] as string[][], completed: [] as string[][], snapshots: [] as CleanupJobStateRow[],
  readHook: undefined as undefined | ((ids: readonly string[]) => void | Promise<void>),
  checkpointHook: undefined as undefined | ((job: OutlookCleanupStoredJob) => void),
  afterCommitHook: undefined as undefined | ((job: OutlookCleanupStoredJob) => void),
  contextHook: undefined as undefined | (() => void), protectedIds: new Set<string>(),
  authorize: vi.fn(), connection: vi.fn(), claims: vi.fn(), releases: vi.fn(), aggregate: vi.fn(),
  slots: vi.fn(), requestLeases: vi.fn(), fence: vi.fn(),
  disconnected: false, active: 0, peakActive: 0, mono: 0
}));
vi.mock("@/lib/server/outlook-cleanup-store", async original => ({
  ...await original<typeof import("@/lib/server/outlook-cleanup-store")>(), createPrismaOutlookCleanupStore: () => h.store!
}));
vi.mock("@/lib/server/production-cleanup", async original => ({
  ...await original<typeof import("@/lib/server/production-cleanup")>(), requireProductionCleanupAccess: h.authorize
}));
vi.mock("@/lib/server/microsoft-connection", () => ({ getActiveMicrosoftConnection: h.connection, forceRefreshMicrosoftConnection: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: {
  cleanupJob: { updateMany: h.aggregate }, cleanupJobState: { count: h.fence },
  providerRequestLease: { upsert: h.slots, updateMany: h.requestLeases }
} }));
vi.mock("@/lib/providers/microsoft/provider", () => ({ MicrosoftProvider: class {
  private requests = 0; private subrequests = 0;
  private coordinate: Coordinate;
  constructor(_token: string, options: { requestCoordinator: Coordinate }) { this.coordinate = options.requestCoordinator; }
  getScanMetrics() { return { requests: this.requests, subrequests: this.subrequests, retries: 0, throttles429: 0, responseBodyJsonMs: 0 }; }
  async getCleanupSafetyContext() {
    h.contextHook?.();
    return { knownFolderIds: ["private-folder"], kindByFolderId: [], sentFolderIds: [], deletedItemsFolderId: "private-deleted" };
  }
  async scanParticipatedConversationIds() { return new Set<string>(); }
  async getCleanupMessages(ids: readonly string[], _context: unknown, targeted: boolean) {
    expect(targeted).toBe(true); expect(ids.length).toBeLessThanOrEqual(20);
    return this.coordinate(async () => {
      this.requests++; this.subrequests += ids.length; h.reads.push([...ids]);
      h.peakActive = Math.max(h.peakActive, ++h.active);
      try {
        await h.readHook?.(ids);
        const records = ids.map(id => ({ parentFolderId: "private-folder", record: {
          providerMessageId: id, provider: "microsoft", senderAddress: "bulk@example.test", receivedAt: new Date("2020-01-01"),
          isRead: false, listId: "private-list", hasListUnsubscribe: true, isStarred: h.protectedIds.has(id)
        } }));
        h.completed.push([...ids]); return records;
      } finally { h.active--; }
    });
  }
} }));

const key = Buffer.alloc(32, 17);
const codec = createCleanupJobStateCodec<OutlookCleanupStoredJob>({
  encrypt: value => encryptCleanupStateWithKey(value, key), decrypt: value => decryptCleanupStateWithKey(value, key)
});
const load = () => codec.decode(h.row!.encryptedPayload);
function initial(requested = 500, poolSize = requested): OutlookCleanupStoredJob {
  return { provider: "microsoft", userId: "owner", acceptanceKey: "frozen-selection", version: 1,
    view: { provider: "microsoft", id: "job", status: "created", requested, approved: 0, excludedBySafety: 0,
      movedVerified: 0, restoredVerified: 0, failed: 0, uncertain: 0, checked: 0,
      chunksCompleted: 0, totalChunks: 5, batchesCompleted: 0, totalBatches: 25, currentChunk: 0, currentBatch: 0,
      effectiveBatchSize: 20, undoBatchesCompleted: 0, undoTotalBatches: 0, graphRequests: 0, httpRoundTrips: 0,
      graphSubrequests: 0, retries: 0, timingMs: createEmptyOutlookCleanupTiming(), httpRoundTripsByPhase: createEmptyOutlookCleanupTiming(),
      groupIndices: [0], undoAvailable: false, undoStatus: "not_available", createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 600_000 },
    payload: { scanId: "scan", providerConnectionId: "connection", selectedSenders: [{ groupIndex: 0, senderKey: "bulk@example.test" }],
      participatedConversationIds: [], targets: [], verificationCursor: 0,
      verificationCandidates: Array.from({ length: poolSize }, (_, index) => ({ messageId: `private-message-${index}`, groupIndex: 0 })) }
  };
}
function install(job = initial()) {
  const time = new Date();
  h.row = { jobId: job.view.id, userId: job.userId, version: job.version, expiresAt: new Date(job.view.expiresAt),
    encryptedPayload: codec.encode(job), createdAt: time, updatedAt: time, lockOwner: null, lockExpiresAt: null };
  const repository: CleanupJobStateRepository = {
    create: async () => { throw new Error("Existing job only"); },
    find: async () => h.row ? structuredClone(h.row) : null,
    replaceIfVersion: async input => {
      h.checkpointHook?.(codec.decode(input.encryptedPayload));
      const row = h.row;
      if (!row || row.userId !== input.userId || row.version !== input.expectedVersion || row.expiresAt <= input.now ||
        (input.lockOwner && (row.lockOwner !== input.lockOwner || !row.lockExpiresAt || row.lockExpiresAt <= input.now))) return false;
      expect(input.creditProgress).toBeUndefined(); // Preparation does not reserve or spend credits.
      row.encryptedPayload = input.encryptedPayload; row.version++; row.expiresAt = input.expiresAt;
      h.snapshots.push(structuredClone(row)); h.afterCommitHook?.(codec.decode(row.encryptedPayload)); return true;
    },
    claim: async input => {
      h.claims(); const row = h.row;
      if (!row || row.expiresAt <= input.now || (row.lockOwner && row.lockExpiresAt && row.lockExpiresAt > input.now)) return false;
      row.lockOwner = input.owner; row.lockExpiresAt = input.lockExpiresAt; return true;
    },
    refreshLock: async input => Boolean(h.row && h.row.lockOwner === input.owner && h.row.lockExpiresAt && h.row.lockExpiresAt > input.now),
    releaseLock: async (_id, owner) => {
      h.releases(); if (h.row?.lockOwner !== owner) return false;
      h.row.lockOwner = null; h.row.lockExpiresAt = null; return true;
    },
    delete: async () => false, deleteForUser: async () => 0, deleteExpired: async () => 0
  };
  h.store = new PrismaCleanupJobStore(repository, codec);
}
async function finish(trace?: VerificationTrace) {
  let steps = 0;
  while (steps++ < 40) {
    const result = await advanceOutlookCleanupJob("job", "prepare", trace);
    trace = result.verificationTrace;
    if (result.outcome === "stop") return { steps, trace };
  }
  throw new Error("Unbounded verification");
}
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(console, "info").mockImplementation(() => {});
  h.reads = []; h.completed = []; h.snapshots = []; h.readHook = undefined; h.checkpointHook = undefined; h.afterCommitHook = undefined; h.contextHook = undefined;
  h.disconnected = false; h.protectedIds = new Set(); h.active = 0; h.peakActive = 0; h.mono = 0;
  h.authorize.mockResolvedValue(undefined); h.connection.mockResolvedValue({ accessToken: "never-log-token", connection: {
    id: "connection", userId: "owner", provider: "microsoft", sessionGeneration: "generation" } });
  h.aggregate.mockResolvedValue({ count: 1 }); h.slots.mockResolvedValue({}); h.requestLeases.mockResolvedValue({ count: 1 });
  h.fence.mockImplementation(async (input: { where: { lockOwner: string } }) => Number(Boolean(h.row && !h.disconnected &&
    h.row.lockOwner === input.where.lockOwner && h.row.expiresAt > new Date() && h.row.lockExpiresAt && h.row.lockExpiresAt > new Date())));
  install();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("verifies exactly 500 in five durable steps/25 sequential Graph batches, preserving every encrypted batch checkpoint", async () => {
  const trace = newVerificationTrace(); trace.scheduledAt = Date.now();
  const result = await providerCleanupWorkflow("job", "prepare", trace);
  expect(result.verificationTrace?.step).toBe(5);
  expect(runProviderCleanupStep.maxRetries).toBe(0);
  expect(h.reads).toHaveLength(25); expect(h.peakActive).toBe(1);
  expect(new Set(h.reads.flat()).size).toBe(500);
  const job = load();
  expect(job.view).toMatchObject({ status: "ready", approved: 500, movedVerified: 0,
    verification: { candidatesChecked: 500, approved: 500, excluded: 0, batchRequests: 25, exactHeaderRequests: 500 } });
  expect(job.payload.targets.map(target => target.originalMessageId)).toEqual(initial().payload.verificationCandidates!.map(target => target.messageId));
  expect(h.snapshots).toHaveLength(31); // Context + 25 per-batch + 5 end-of-unit checkpoints.
  expect(h.authorize).toHaveBeenCalledTimes(5); expect(h.connection).toHaveBeenCalledTimes(5);
  expect(h.aggregate).toHaveBeenCalledTimes(5); expect(h.slots).toHaveBeenCalledTimes(10);
  expect(h.fence).toHaveBeenCalledTimes(50); expect(h.requestLeases).toHaveBeenCalledTimes(50);
  expect(JSON.stringify(h.snapshots)).not.toMatch(/private-message|bulk@|private-folder|never-log-token/);
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/private-message|bulk@|private-folder|never-log-token/);
  const before = h.reads.length;
  await runProviderCleanupStep("job", "prepare"); // Terminal step replay cannot approve/read again.
  expect(h.reads).toHaveLength(before); expect(load().view.approved).toBe(500);
});
it("handles a partial final chunk without fetching beyond the exact requested selection", async () => {
  install(initial(135, 160)); expect((await finish()).steps).toBe(2);
  expect(h.reads.map(batch => batch.length)).toEqual([20, 20, 20, 20, 20, 20, 15]);
  expect(load().payload.verificationCursor).toBe(135);
});
it("matches single-batch eligibility with exact approved/excluded counts and selected-pool exhaustion", async () => {
  install(initial(500, 500)); h.protectedIds = new Set(Array.from({ length: 37 }, (_, index) => `private-message-${index}`));
  expect((await finish()).steps).toBe(5);
  expect(load().view).toMatchObject({ status: "ready", approved: 463, verification: { candidatesChecked: 500, approved: 463, excluded: 37 } });
  expect(new Set(load().payload.targets.map(target => target.originalMessageId)).size).toBe(463);
  const baseline = initial(500, 500);
  const provider = {
    getCleanupSafetyContext: async () => ({ knownFolderIds: ["private-folder"], kindByFolderId: [], sentFolderIds: [], deletedItemsFolderId: "private-deleted" }),
    scanParticipatedConversationIds: async () => new Set(),
    getCleanupMessages: async (ids: readonly string[]) => ids.map(id => ({ parentFolderId: "private-folder", record: {
      providerMessageId: id, provider: "microsoft", senderAddress: "bulk@example.test", receivedAt: new Date("2020-01-01"),
      isRead: false, listId: "private-list", hasListUnsubscribe: true, isStarred: h.protectedIds.has(id)
    } }))
  };
  while (baseline.view.status !== "ready") await prepareOutlookJob(baseline, provider as never, async () => {}, 1);
  expect(load().payload.targets).toEqual(baseline.payload.targets);
  expect(load().payload.verificationCursor).toBe(baseline.payload.verificationCursor);
  expect(load().view.verification).toMatchObject({ candidatesChecked: baseline.view.verification!.candidatesChecked,
    approved: baseline.view.verification!.approved, excluded: baseline.view.verification!.excluded });
});
it("yields between batches after the time budget and includes safety-context setup in the budget", async () => {
  vi.spyOn(performance, "now").mockImplementation(() => h.mono);
  h.readHook = () => { h.mono += 8000; };
  expect((await advanceOutlookCleanupJob("job", "prepare")).outcome).toBe("continue");
  expect(h.reads).toHaveLength(2); expect(load().payload.verificationCursor).toBe(40);
  install(initial(100)); h.reads = []; h.readHook = undefined; h.contextHook = () => { h.mono += 16_000; };
  expect((await advanceOutlookCleanupJob("job", "prepare")).outcome).toBe("continue");
  expect(h.reads).toHaveLength(0); h.contextHook = undefined;
  await advanceOutlookCleanupJob("job", "prepare"); expect(load().view.status).toBe("ready");
});
it.each(["read_interruption", "uncommitted_checkpoint"])("resumes from the exact 60-message checkpoint after %s and ownership replacement", async fault => {
  const loseOwner = () => { h.row!.lockOwner = "replacement"; h.row!.lockExpiresAt = new Date(Date.now() + 60_000); };
  if (fault === "read_interruption") h.readHook = () => { if (h.reads.length === 4) { loseOwner(); throw new Error("simulated worker loss"); } };
  else h.checkpointHook = job => { if (job.payload.verificationCursor === 80) loseOwner(); };
  await advanceOutlookCleanupJob("job", "prepare");
  expect(load().payload.verificationCursor).toBe(60); expect(load().view.approved).toBe(60);
  expect(load().view.status).toBe("resolving");
  const reads = h.reads.length;
  await advanceOutlookCleanupJob("job", "prepare"); expect(h.reads).toHaveLength(reads); // Cannot reclaim live lease.
  h.row!.lockExpiresAt = new Date(Date.now() - 1); h.readHook = undefined; h.checkpointHook = undefined;
  await finish();
  expect(load().view).toMatchObject({ status: "ready", approved: 500, verification: { candidatesChecked: 500, excluded: 0 } });
  expect(new Set(load().payload.targets.map(target => target.originalMessageId)).size).toBe(500);
  for (const id of initial().payload.verificationCandidates!.slice(0, 60).map(target => target.messageId))
    expect(h.reads.flat().filter(value => value === id)).toHaveLength(1);
});
it("fails closed on a caught provider failure after committed batches rather than inventing an automatic retry", async () => {
  h.readHook = () => { if (h.reads.length === 4) throw new Error("provider failure"); };
  await advanceOutlookCleanupJob("job", "prepare");
  expect(load().view.status).toBe("failed"); expect(load().payload.verificationCursor).toBe(60);
  await advanceOutlookCleanupJob("job", "prepare"); expect(h.reads).toHaveLength(4);
});
it("observes an advanced cursor after a committed checkpoint response is lost, without repeating committed reads", async () => {
  let lost = false;
  h.afterCommitHook = job => { if (!lost && job.payload.verificationCursor === 60) {
    lost = true; throw new Error("committed response lost");
  } };
  await advanceOutlookCleanupJob("job", "prepare");
  expect(load().payload.verificationCursor).toBe(60); expect(load().view.status).toBe("resolving");
  h.afterCommitHook = undefined;
  await finish();
  expect(load().view).toMatchObject({ status: "ready", approved: 500, verification: { candidatesChecked: 500 } });
  expect(h.reads.flat()).toHaveLength(500); expect(new Set(h.reads.flat()).size).toBe(500);
});
it.each(["disconnect", "expiry", "deleted_state"])("fences later Graph work inside a chunk after %s", async fault => {
  h.readHook = () => { if (h.reads.length === 3) {
    if (fault === "disconnect") h.disconnected = true;
    if (fault === "expiry") h.row!.expiresAt = new Date(Date.now() - 1);
    if (fault === "deleted_state") h.row = undefined;
  } };
  await advanceOutlookCleanupJob("job", "prepare"); expect(h.reads).toHaveLength(3);
  await advanceOutlookCleanupJob("job", "prepare"); expect(h.reads).toHaveLength(3);
});
it("denies unauthorized preparation and prevents duplicate concurrent invocations from sharing the lease", async () => {
  h.authorize.mockRejectedValueOnce(new Error("unauthorized"));
  await advanceOutlookCleanupJob("job", "prepare"); expect(h.reads).toHaveLength(0);
  install(); h.authorize.mockResolvedValue(undefined);
  await Promise.all([advanceOutlookCleanupJob("job", "prepare"), advanceOutlookCleanupJob("job", "prepare")]);
  expect(h.reads).toHaveLength(5); expect(load().view.approved).toBe(100);
  expect(h.peakActive).toBe(1);
});
