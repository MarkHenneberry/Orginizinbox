import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getOutlookCleanupForPresentation, isOutlookPreMutationJob, serializeOutlookCleanupJob, type OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";
import { outlookCleanupUiJob } from "@/lib/server/production-cleanup-response";
import { createDefaultCleanupSelection } from "@/lib/domain/cleanup-sender-workspace";
import { GmailCleanupClient } from "@/components/product/GmailCleanupClient";
import { getFixtureInboxReport } from "@/lib/fixtures/inbox";
import { buildCleanupSenderGroups } from "@/lib/providers/gmail/cleanup-candidates";

const h = vi.hoisted(() => ({ rows: vi.fn(), find: vi.fn(), jobs: new Map<string, unknown>() }));
vi.mock("@/lib/server/db", () => ({ prisma: { cleanupJobState: { findMany: h.rows, findUnique: h.find } } }));
vi.mock("@/lib/server/crypto", () => ({ encryptCleanupState: (value: string) => value, decryptCleanupState: (value: string) => value }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
const group = buildCleanupSenderGroups(getFixtureInboxReport().senders).find(group => group.eligible)!;
function job(id: string, status: OutlookCleanupStoredJob["view"]["status"] = "ready"): OutlookCleanupStoredJob {
  return { provider: "microsoft", userId: "owner", version: 1, acceptanceKey: "acceptance", view: {
    provider: "microsoft", id, status, requested: 5, approved: 5, excludedBySafety: 0, movedVerified: 0, restoredVerified: 0,
    failed: 0, uncertain: 0, checked: 0, chunksCompleted: 0, totalChunks: 1, batchesCompleted: 0, totalBatches: 1,
    currentChunk: 0, currentBatch: 0, effectiveBatchSize: 5, undoBatchesCompleted: 0, undoTotalBatches: 0,
    graphRequests: 0, httpRoundTrips: 0, graphSubrequests: 0, retries: 0,
    timingMs: { preflight: 0, finalRecheck: 0, move: 0, verification: 0, undoMove: 0, undoVerification: 0 },
    httpRoundTripsByPhase: { preflight: 0, finalRecheck: 0, move: 0, verification: 0, undoMove: 0, undoVerification: 0 },
    groupIndices: [group.index], undoAvailable: false, undoStatus: "not_available", createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 600_000,
    verification: { candidatesChecked: 5, approved: 5, excluded: 0, exactHeaderRequests: 5, batchRequests: 1, retries: 0, throttles: 0, responseBodyJsonMs: 0, verificationDurationMs: 10 }
  }, payload: { scanId: `scan-${id}`, providerConnectionId: "connection", selectedSenders: [{ groupIndex: group.index, senderKey: "private@example.test" }],
    senderGroups: [group], participatedConversationIds: [], targets: [] } };
}
const render = (provider: "gmail" | "microsoft", stored?: OutlookCleanupStoredJob, groups = [group]) => renderToStaticMarkup(createElement(GmailCleanupClient, {
  groups, provider, initialOutlookJob: stored ? outlookCleanupUiJob(serializeOutlookCleanupJob(stored)) : undefined,
  countOptions: [5, 25, 100, 500], developmentMode: false, productionAccess: "available", cleanupEnabled: true,
  scalableCleanupEnabled: false, legacyCleanupMaximum: 0, bulkUndoProofEnabled: false, fixtureMode: false, reportStale: false
}));
function storedRow(id: string, scanId = `scan-${id}`) {
  return { jobId: id, userId: "owner", version: 1, expiresAt: new Date(Date.now() + 600_000),
    encryptedPayload: JSON.stringify(h.jobs.get(id)), job: { scanId } };
}
beforeEach(() => { vi.stubEnv("NODE_ENV", "production"); h.jobs.clear(); h.rows.mockReset().mockResolvedValue([]); h.find.mockClear(); });
afterEach(() => vi.unstubAllEnvs());
it("starts Outlook with zero selected senders and a disabled check action while retaining Gmail defaults", () => {
  expect([...createDefaultCleanupSelection([group], "microsoft")]).toEqual([]);
  expect([...createDefaultCleanupSelection([group], "gmail")]).toEqual([group.index]);
  const html = render("microsoft");
  expect(html).not.toContain("checked=\"\""); expect(html).toContain("Select one or more sender groups to check");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check 500 messages/);
  expect(render("gmail")).toContain("checked=\"\"");
});
it.each(["created", "resolving", "ready"] as const)("fresh entry ignores an old %s preparation without deleting it", async status => {
  const prepared = job("prepared", status); h.jobs.set("prepared", prepared);
  h.rows.mockResolvedValue([storedRow("prepared")]);
  expect(await getOutlookCleanupForPresentation("owner", "connection", true)).toBeUndefined();
  expect(await getOutlookCleanupForPresentation("owner", "connection")).toEqual(JSON.parse(JSON.stringify(prepared)));
  expect(h.jobs.has("prepared")).toBe(true);
  expect(h.rows.mock.calls[0][0].where).toMatchObject({ userId: "owner", job: { scan: { provider: "microsoft", providerConnectionId: "connection" } } });
});
it("reload after discard excludes cancelled jobs and opens fresh with zero selected groups", async () => {
  const stored = await getOutlookCleanupForPresentation("owner", "connection");
  expect(h.rows.mock.calls[0][0].where.job.status).toEqual({ not: "cancelled" });
  expect(stored).toBeUndefined();
  const html = render("microsoft", stored);
  expect(html).toContain("Select one or more sender groups to check");
  expect(html).not.toContain("checked=\"\"");
  expect(html).not.toContain("Change selection");
});
it.each(["running", "complete", "partial", "uncertain", "undoing", "undo_complete"] as const)("an older %s job takes precedence over a new prepared job even on fresh entry", async status => {
  h.jobs.set("prepared", job("prepared")); const recovery = job("recovery", status); h.jobs.set("recovery", recovery);
  h.rows.mockResolvedValue(["prepared", "recovery"].map(id => storedRow(id)));
  expect(await getOutlookCleanupForPresentation("owner", "connection", true)).toEqual(JSON.parse(JSON.stringify(recovery)));
  expect(h.rows).toHaveBeenCalledOnce();
  expect(h.find).not.toHaveBeenCalled();
  expect(isOutlookPreMutationJob(recovery)).toBe(false);
});
it("never accepts mismatched scan or connection ownership as presentation context", async () => {
  h.jobs.set("wrong", job("wrong")); h.rows.mockResolvedValue([storedRow("wrong", "another-scan")]);
  await expect(getOutlookCleanupForPresentation("owner", "connection", true)).rejects.toThrow("ownership");
});
it.each(["user", "version", "job", "connection", "ciphertext"])("rejects a mismatched %s envelope in the batched read", async mismatch => {
  h.jobs.set("prepared", job("prepared"));
  const row = storedRow("prepared");
  if (mismatch === "user") row.userId = "someone-else";
  if (mismatch === "version") row.version = 99;
  if (mismatch === "job") row.jobId = "another-job";
  if (mismatch === "connection") row.encryptedPayload = row.encryptedPayload.replace('"providerConnectionId":"connection"', '"providerConnectionId":"other"');
  if (mismatch === "ciphertext") row.encryptedPayload = "invalid encrypted data";
  h.rows.mockResolvedValue([row]);
  await expect(getOutlookCleanupForPresentation("owner", "connection")).rejects.toThrow();
  expect(h.find).not.toHaveBeenCalled();
});
it("ignores rows that expire between the batched query and decoding", async () => {
  h.jobs.set("expired", job("expired"));
  h.rows.mockResolvedValue([{ ...storedRow("expired"), expiresAt: new Date(Date.now() - 1) }]);
  expect(await getOutlookCleanupForPresentation("owner", "connection")).toBeUndefined();
});
it("retains selected sender context without a report, never persists it in a terminal snapshot, and hides naked confirmation without context", () => {
  const prepared = job("ready");
  const html = render("microsoft", prepared, []);
  expect(html).toContain(group.displayName); expect(html).toContain("Move 5 to Deleted Items");
  expect(html).toContain("Change selection"); expect(html).toContain("Candidates checked");
  expect(html).not.toContain("Sender details are no longer available");
  expect(JSON.stringify(serializeOutlookCleanupJob(prepared, false))).not.toContain(group.displayName);
  prepared.payload.senderGroups = undefined;
  const missing = render("microsoft", prepared, []);
  expect(missing).toContain("Sender details are no longer available"); expect(missing).not.toContain("Move 5 to Deleted Items");
});
