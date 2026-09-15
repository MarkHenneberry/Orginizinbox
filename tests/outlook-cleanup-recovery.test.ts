import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyOutlookCleanupTiming } from "@/lib/domain/outlook-cleanup";
import type { OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";

const mocks = vi.hoisted(() => ({ get: vi.fn(), compareAndSet: vi.fn(), start: vi.fn(), session: vi.fn(),
  claim: vi.fn(), refreshLock: vi.fn(), releaseLock: vi.fn(), move: vi.fn(), aggregate: vi.fn(), safety: vi.fn(),
  connection: vi.fn(), owned: vi.fn(), paid: vi.fn() }));
vi.mock("@/lib/server/outlook-cleanup-store", async (original) => ({
  ...await original<typeof import("@/lib/server/outlook-cleanup-store")>(),
  createPrismaOutlookCleanupStore: () => ({ get: mocks.get, compareAndSet: mocks.compareAndSet,
    claim: mocks.claim, refreshLock: mocks.refreshLock, releaseLock: mocks.releaseLock })
}));
vi.mock("@/lib/server/db", () => ({ prisma: { cleanupJob: { updateMany: mocks.aggregate },
  providerConnection: { findFirst: mocks.connection }, cleanupJobState: { count: mocks.owned } } }));
vi.mock("@/lib/billing/entitlements", () => ({ requirePaidCleanupEntitlement: mocks.paid }));
vi.mock("@/lib/server/microsoft-connection", () => ({
  getActiveMicrosoftConnection: async () => ({ accessToken: "fixture", connection: { id: "connection" } }),
  forceRefreshMicrosoftConnection: vi.fn()
}));
vi.mock("@/lib/server/live-scan-store", () => ({ markLiveReportStale: vi.fn() }));
vi.mock("@/lib/providers/microsoft/provider", () => ({ MicrosoftProvider: class {
  getScanMetrics() { return { requests: 0, subrequests: 0, retries: 0 }; }
  scanParticipatedConversationIds() { return new Set(); }
  getCleanupSafetyContext() { return mocks.safety(); }
  getCleanupMessages(ids: string[]) {
    return ids.map((id) => ({ record: { providerMessageId: id, provider: "microsoft", senderAddress: "bulk@example.test",
      receivedAt: new Date("2020-01-01"), isRead: false, listId: "list.example.test", hasListUnsubscribe: true }, parentFolderId: "inbox" }));
  }
  moveCleanupMessages(inputs: unknown) { return mocks.move(inputs); }
  verifyCleanupMessageLocations(inputs: unknown[]) { return inputs.map(() => true); }
} }));
vi.mock("@/lib/server/provider-cleanup-workflow-start", () => ({ startProviderCleanupWorkflow: mocks.start }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/config", async (original) => {
  const actual = await original<typeof import("@/lib/config")>();
  return { ...actual, runtimeConfig: { ...actual.runtimeConfig, microsoftAvailable: true, gmailScalableStoreAdapter: "prisma",
    microsoftOAuthDevEnabled: true, outlookCleanupDevEnabled: true, fixtureMode: false } };
});

import { advanceOutlookCleanupJob, undoOutlookCleanup } from "@/lib/server/outlook-cleanup";

let job: OutlookCleanupStoredJob;
beforeEach(() => {
  vi.clearAllMocks();
  job = {
    userId: "owner", provider: "microsoft", acceptanceKey: "same-selection", version: 1,
    view: {
      provider: "microsoft", id: "same-job", status: "uncertain", requested: 3,
      approved: 3, excludedBySafety: 0, movedVerified: 1, restoredVerified: 0, failed: 1, uncertain: 1,
      checked: 3, chunksCompleted: 0, totalChunks: 1, batchesCompleted: 0, totalBatches: 1,
      currentChunk: 1, currentBatch: 1, effectiveBatchSize: 5, undoBatchesCompleted: 0, undoTotalBatches: 0,
      graphRequests: 0, httpRoundTrips: 0, graphSubrequests: 0, retries: 0,
      httpRoundTripsByPhase: createEmptyOutlookCleanupTiming(), timingMs: createEmptyOutlookCleanupTiming(),
      groupIndices: [0], undoAvailable: false, undoStatus: "uncertain",
      createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 60_000
    },
    payload: {
      scanId: "scan", providerConnectionId: "connection", selectedSenders: [], participatedConversationIds: [],
      targets: [
        { originalMessageId: "original-1", movedMessageId: "returned-1", originalFolderId: "folder-1", groupIndex: 0, state: "moved_verified" },
        { originalMessageId: "original-2", groupIndex: 0, state: "move_uncertain" },
        { originalMessageId: "original-3", groupIndex: 0, state: "move_failed" }
      ]
    }
  };
  mocks.session.mockResolvedValue({ userId: "owner" });
  mocks.get.mockImplementation(async (userId, jobId) =>
    userId === job.userId && jobId === job.view.id && job.view.expiresAt > Date.now() ? structuredClone(job) : undefined);
  mocks.compareAndSet.mockImplementation(async (_userId, _id, version, update) => {
    if (version !== job.version) return undefined;
    job = update(structuredClone(job));
    job.version += 1;
    return structuredClone(job);
  });
  mocks.start.mockResolvedValue({ runId: "run" });
  mocks.claim.mockImplementation(async () => structuredClone(job));
  mocks.refreshLock.mockResolvedValue(true);
  mocks.releaseLock.mockResolvedValue(true);
  mocks.aggregate.mockResolvedValue({ count: 1 });
  mocks.safety.mockResolvedValue({ knownFolderIds: ["inbox", "deleted"], kindByFolderId: [], sentFolderIds: [], deletedItemsFolderId: "deleted" });
  mocks.move.mockImplementation(async (inputs: Array<{ messageId: string }>) =>
    inputs.map(({ messageId }) => ({ outcome: "success", messageId: `moved-${messageId}` })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function productionRollback() {
  const env = { NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "https://example.test", DATABASE_URL: "postgresql://localhost/fixture",
    TOKEN_ENCRYPTION_KEY: "t".repeat(32), CLEANUP_STATE_ENCRYPTION_KEY: "s".repeat(32), CRON_SECRET: "fixture",
    MICROSOFT_PRODUCTION_ENABLED: "true", MICROSOFT_PRODUCTION_CLEANUP_ENABLED: "false", CLEANUP_WORKFLOW_ENABLED: "true",
    MICROSOFT_CLIENT_ID: "fixture", MICROSOFT_CLIENT_SECRET: "fixture", MICROSOFT_REDIRECT_URI: "https://example.test/api/oauth/microsoft/callback",
    STRIPE_SECRET_KEY: "" };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  mocks.connection.mockResolvedValue({ id: "connection", encryptedAccessToken: "encrypted", encryptedRefreshToken: "encrypted", scope: "Mail.ReadWrite" });
  mocks.owned.mockResolvedValue(1);
  mocks.paid.mockRejectedValue(new Error("Paid access has expired"));
}

it("restores only the verified ledger through the real service/worker after production rollout is disabled", async () => {
  productionRollback();
  await undoOutlookCleanup("same-job");
  expect(mocks.start).toHaveBeenCalledWith("same-job", "undo");
  await advanceOutlookCleanupJob("same-job", "undo");
  expect(mocks.move).toHaveBeenCalledExactlyOnceWith([{ messageId: "returned-1", destinationFolderId: "folder-1" }]);
  expect(job.view.restoredVerified).toBe(1);
  expect(job.view.uncertain).toBe(1);
  expect(job.view.status).not.toBe("undo_complete");
  expect(mocks.paid).not.toHaveBeenCalled();
});

it("allows verification-only re-entry after rollback without moving a later frozen target", async () => {
  productionRollback();
  job.view.status = "running";
  job.view.uncertain = 0;
  job.view.failed = 0;
  job.view.movedVerified = 0;
  job.payload.targets = [
    { originalMessageId: "original-1", movedMessageId: "returned-1", originalFolderId: "folder-1", groupIndex: 0, state: "move_dispatched" },
    { originalMessageId: "untouched", groupIndex: 0, state: "frozen" }
  ];
  job.payload.activeMoveBatchIndexes = [0];
  expect(await advanceOutlookCleanupJob("same-job", "cleanup")).toEqual({ outcome: "continue" });
  expect(job.payload.targets.map((target) => target.state)).toEqual(["moved_verified", "frozen"]);
  expect(mocks.move).not.toHaveBeenCalled();
  expect(mocks.paid).not.toHaveBeenCalled();
  // The next unit cannot use the verification exception to start another move.
  expect(await advanceOutlookCleanupJob("same-job", "cleanup")).toEqual({ outcome: "stop" });
  expect(mocks.move).not.toHaveBeenCalled();
  expect(job.view.undoAvailable).toBe(true);
});

describe("Outlook worker checkpoint performance", () => {
  function pendingJob() {
    job.view.status = "running";
    job.view.uncertain = 0;
    job.view.failed = 0;
    job.view.movedVerified = 0;
    job.payload.selectedSenders = [{ groupIndex: 0, senderKey: "bulk@example.test" }];
    job.payload.targets = [{ originalMessageId: "frozen", groupIndex: 0, state: "frozen" }];
  }

  it("keeps every CAS checkpoint without redundantly renewing a freshly claimed lease", async () => {
    pendingJob();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await advanceOutlookCleanupJob("same-job", "cleanup");
    expect(job.view.movedVerified).toBe(1);
    expect(mocks.compareAndSet).toHaveBeenCalledTimes(5);
    expect(mocks.refreshLock).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it("fails closed before mutation when a due heartbeat is rejected", async () => {
    pendingJob();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.safety.mockImplementationOnce(async () => {
      now += 31_000;
      return { knownFolderIds: ["inbox", "deleted"], kindByFolderId: [], sentFolderIds: [], deletedItemsFolderId: "deleted" };
    });
    mocks.refreshLock.mockResolvedValueOnce(false);
    expect(await advanceOutlookCleanupJob("same-job", "cleanup")).toEqual({ outcome: "stop" });
    expect(mocks.refreshLock).toHaveBeenCalledOnce();
    expect(mocks.move).not.toHaveBeenCalled();
    expect(job.view.status).toBe("failed");
  });
});

describe("Outlook Recovery Undo acceptance", () => {
  it("accepts the exact verified ledger despite the old blanket Undo-disabled flag", async () => {
    const view = await undoOutlookCleanup("same-job");
    expect(view).toMatchObject({ status: "undoing", undoMode: "recovery", recoverableCount: 1, uncertain: 1, failed: 1 });
    expect(job.payload.targets.map((target) => target.state)).toEqual(["moved_verified", "move_uncertain", "move_failed"]);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith("same-job", "undo");
    expect(JSON.stringify(view)).not.toMatch(/original-1|returned-1|folder-1|originalMessageId|movedMessageId/);
  });

  it.each(["move_dispatching", "move_dispatched", "restore_dispatching", "restore_dispatched"] as const)(
    "normalizes old stopped %s intent to exact uncertainty without including it in recovery", async (state) => {
      job.payload.targets[1].state = state;
      await undoOutlookCleanup("same-job");
      expect(job.payload.targets[1].state).toBe(state.startsWith("restore") ? "restore_uncertain" : "move_uncertain");
      expect(job.view).toMatchObject({ uncertain: 1, recoverableCount: 1, undoMode: "recovery" });
      expect(job.payload.forwardCleanupStopped).toBe(true);
    }
  );

  it("re-dispatches the same recovery after scheduling failure without changing its ledger", async () => {
    mocks.start.mockRejectedValueOnce(new Error("scheduler unavailable"));
    await expect(undoOutlookCleanup("same-job")).rejects.toThrow("scheduler unavailable");
    const accepted = structuredClone(job);
    await undoOutlookCleanup("same-job");
    expect(job).toEqual(accepted);
    expect(mocks.compareAndSet).toHaveBeenCalledTimes(1);
    expect(mocks.start.mock.calls).toEqual([["same-job", "undo"], ["same-job", "undo"]]);
  });

  it("uses one CAS transition for simultaneous recovery requests", async () => {
    const results = await Promise.allSettled([undoOutlookCleanup("same-job"), undoOutlookCleanup("same-job")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(job.version).toBe(2);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    await undoOutlookCleanup("same-job");
    expect(job.version).toBe(2);
  });

  it("rejects uncertain-only, missing-ID, wrong-owner, expired and active-forward jobs", async () => {
    job.payload.targets[0].state = "move_uncertain";
    await expect(undoOutlookCleanup("same-job")).rejects.toThrow("No exact verified");
    job.payload.targets[0].state = "moved_verified";
    job.payload.targets[0].movedMessageId = undefined;
    await expect(undoOutlookCleanup("same-job")).rejects.toThrow("No exact verified");
    job.payload.targets[0].movedMessageId = "returned-1";
    mocks.session.mockResolvedValueOnce({ userId: "another-user" });
    await expect(undoOutlookCleanup("same-job")).rejects.toThrow("expired");
    job.view.status = "running";
    await expect(undoOutlookCleanup("same-job")).rejects.toThrow("No exact verified");
    job.view.status = "uncertain";
    job.view.expiresAt = Date.now() - 1;
    await expect(undoOutlookCleanup("same-job")).rejects.toThrow("expired");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.compareAndSet).not.toHaveBeenCalled();
  });
});
