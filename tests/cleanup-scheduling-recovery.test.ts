import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGmailScalableChunkViews } from "@/lib/domain/gmail-scalable-cleanup";
import type { GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";

const mocks = vi.hoisted(() => ({ get: vi.fn(), compareAndSet: vi.fn(), start: vi.fn(), authorized: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/server/gmail-scalable-cleanup-durable-store", async (original) => ({
  ...await original<typeof import("@/lib/server/gmail-scalable-cleanup-durable-store")>(),
  createPrismaGmailScalableCleanupStore: () => ({ get: mocks.get, compareAndSet: mocks.compareAndSet })
}));
vi.mock("@/lib/server/gmail-scalable-workflow-start", () => ({
  startGmailScalableCleanupWorkflow: mocks.start, startGmailScalableUndoWorkflow: vi.fn()
}));
vi.mock("@/lib/server/db", () => ({ prisma: { cleanupJob: { count: mocks.authorized, updateMany: mocks.sync } } }));

import { confirmDurableGmailScalableCleanup } from "@/lib/server/gmail-scalable-live-workflow";
import { createGmailScalableWorkflowCoordinator } from "@/lib/server/gmail-scalable-workflow-coordinator";

let job: GmailScalableStoredJob;
beforeEach(() => {
  vi.clearAllMocks();
  const chunks = createGmailScalableChunkViews(250);
  job = {
    userId: "owner", version: 1, acceptanceKey: "same-selection",
    view: { id: "same-job", status: "ready", requestedCount: 250, chunks, chunkCount: 1,
      groupIndices: [0], suggestedDeltas: [], createdAt: Date.now(), updatedAt: Date.now(),
      expiresAt: Date.now() + 1_800_000 },
    payload: { chunks: [{ index: 0, targets: [], safeTargetIndexes: [], verifiedMovedIndexes: [], verifiedRestoredIndexes: [] }],
      quotaWindow: { startedAt: Date.now(), consumedUnits: 0 } }
  } as unknown as GmailScalableStoredJob;
  mocks.get.mockImplementation(async (userId, id) => userId === job.userId && id === job.view.id ? structuredClone(job) : undefined);
  mocks.compareAndSet.mockImplementation(async (_user, _id, version, update) => {
    if (version !== job.version) return undefined;
    job = update(structuredClone(job));
    job.version += 1;
    return structuredClone(job);
  });
  mocks.start.mockResolvedValue({ runId: "opaque-run" });
  mocks.authorized.mockResolvedValue(1);
});

describe("Gmail confirmation scheduling recovery", () => {
  it("does not overwrite durable cancellation with a late aggregate update", async () => {
    const coordinator = createGmailScalableWorkflowCoordinator();
    const writer = (coordinator as unknown as { aggregateWriter: { sync: (job: GmailScalableStoredJob) => Promise<void> } }).aggregateWriter;
    await writer.sync(job);
    expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "same-job", status: { not: "cancelled" } } }));
  });
  it("re-dispatches the same accepted job after scheduling fails without resetting confirmation", async () => {
    mocks.start.mockRejectedValueOnce(new Error("scheduler unavailable"));
    await expect(confirmDurableGmailScalableCleanup("owner", "same-job")).rejects.toThrow("scheduler unavailable");
    const confirmed = structuredClone(job);
    await expect(confirmDurableGmailScalableCleanup("owner", "same-job")).resolves.toMatchObject({ id: "same-job" });
    expect(job).toEqual(confirmed);
    expect(mocks.compareAndSet).toHaveBeenCalledTimes(1);
    expect(mocks.start.mock.calls).toEqual([["same-job"], ["same-job"]]);
  });

  it("converges simultaneous confirmations on one CAS and one job", async () => {
    await expect(Promise.all([
      confirmDurableGmailScalableCleanup("owner", "same-job"),
      confirmDurableGmailScalableCleanup("owner", "same-job")
    ])).resolves.toHaveLength(2);
    expect(job.version).toBe(2);
    expect(mocks.start.mock.calls.every(([id]) => id === "same-job")).toBe(true);
  });

  it.each(["safety_checking", "mutating", "verifying", "chunk_complete", "paused"] as const)(
    "preserves dispatch intent and exact ledgers while re-dispatching %s", async (status) => {
      job.view.status = status;
      job.payload.confirmedAt = 123;
      job.payload.chunks[0].trashMutationDispatched = true;
      job.payload.chunks[0].verifiedMovedIndexes = [0];
      const frozen = structuredClone(job);
      await confirmDurableGmailScalableCleanup("owner", "same-job");
      expect(job).toEqual(frozen);
      expect(mocks.compareAndSet).not.toHaveBeenCalled();
      expect(mocks.start).toHaveBeenCalledExactlyOnceWith("same-job");
    }
  );

  it.each(["complete", "failed", "partial", "uncertain", "expired", "undoing"] as const)(
    "does not re-dispatch %s jobs", async (status) => {
      job.view.status = status;
      job.payload.confirmedAt = 123;
      await confirmDurableGmailScalableCleanup("owner", "same-job").catch(() => undefined);
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.compareAndSet).not.toHaveBeenCalled();
    }
  );

  it("rejects disconnected/cancelled, wrong-owner, missing and restore-in-progress jobs", async () => {
    mocks.authorized.mockResolvedValue(0);
    await expect(confirmDurableGmailScalableCleanup("owner", "same-job")).rejects.toThrow("authorization");
    await expect(confirmDurableGmailScalableCleanup("different-owner", "same-job")).rejects.toThrow("expired");
    mocks.authorized.mockResolvedValue(1);
    job.view.status = "paused";
    job.view.restoreMode = "recovery";
    job.payload.confirmedAt = 123;
    await expect(confirmDurableGmailScalableCleanup("owner", "same-job")).rejects.toThrow("not ready");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not treat unconfirmed preflight as accepted Trash authorization", async () => {
    job.view.status = "safety_checking";
    await confirmDurableGmailScalableCleanup("owner", "same-job");
    expect(job.payload.confirmedAt).toBeUndefined();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
