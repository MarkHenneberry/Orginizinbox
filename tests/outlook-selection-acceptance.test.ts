import { beforeEach, expect, it, vi } from "vitest";
import { createOutlookBaseState, snapshotOutlookBase } from "@/lib/domain/outlook-report";
import { decryptCleanupState } from "@/lib/server/crypto";
import { startOutlookCleanup } from "@/lib/server/outlook-cleanup";
import type { OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";

const h = vi.hoisted(() => ({ live: vi.fn(), state: vi.fn(), job: vi.fn(), schedule: vi.fn() }));
vi.mock("@/lib/config", () => ({ env: { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"), CLEANUP_STATE_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64") },
  runtimeConfig: { fixtureMode: false, microsoftOAuthDevEnabled: true, outlookCleanupDevEnabled: true, cleanupStateActiveTtlSeconds: 1800 } }));
vi.mock("@/lib/server/session", () => ({ getSession: async () => ({ userId: "owner", providerConnectionId: "connection" }) }));
vi.mock("@/lib/server/microsoft-connection", () => ({ getActiveMicrosoftConnection: async () => ({ accessToken: "fixture", connection: { id: "connection" } }) }));
vi.mock("@/lib/server/live-scan-store", () => ({ getLiveScan: h.live }));
vi.mock("@/lib/server/provider-cleanup-workflow-start", () => ({ startProviderCleanupWorkflow: h.schedule }));
vi.mock("@/lib/server/db", () => ({ prisma: { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
  scan: { upsert: async () => ({}) }, cleanupJob: { create: h.job }, cleanupJobState: { create: h.state }
}) } }));
beforeEach(() => {
  vi.clearAllMocks();
  const base = createOutlookBaseState(Array.from({ length: 60 }, (_, i) => ({ provider: "microsoft", providerMessageId: `private-id-${i}`,
    senderAddress: i < 30 ? "selected@example.test" : "unselected@example.test", receivedAt: new Date("2020-01-01"), isRead: false })), Date.now());
  h.live.mockResolvedValue({ progress: { scanId: "opaque-scan", status: "completed", provider: "microsoft" },
    report: snapshotOutlookBase(base, new Set()), outlookBase: base, participatedConversationIds: new Set() });
});
it("accepts only server-resolved selected-group IDs, ignores injected identities/approval, and exposes aggregate state only", async () => {
  const live = await h.live();
  const index = live.report.senders.findIndex((sender: { senderKey: string }) => sender.senderKey === "selected@example.test");
  const response = await startOutlookCleanup({ groupIndices: [index], requestedCount: 5, messageIds: ["attacker-id"], approved: 500 } as Parameters<typeof startOutlookCleanup>[0]);
  const persisted = h.state.mock.calls[0][0].data;
  const job = JSON.parse(decryptCleanupState(persisted.encryptedPayload)) as OutlookCleanupStoredJob;
  expect(job.payload.verificationCandidates).toHaveLength(30);
  expect(job.payload.verificationCandidates?.every(candidate => Number(candidate.messageId.replace("private-id-", "")) < 30)).toBe(true);
  expect(job.payload.targets).toEqual([]); expect(job.payload.confirmedAt).toBeUndefined(); expect(response.approved).toBe(0);
  expect(JSON.stringify(response)).not.toMatch(/private-id|example.test|attacker-id|verificationCandidates/);
  expect(JSON.stringify(persisted)).not.toMatch(/private-id|example.test|attacker-id/);
  expect(h.schedule).toHaveBeenCalledWith(response.id, "prepare");
});
it("rejects invalid selection indices and obsolete reports without a frozen base pool before creating jobs", async () => {
  await expect(startOutlookCleanup({ groupIndices: [999], requestedCount: 5 })).rejects.toThrow("selection is invalid");
  const live = await h.live(); h.live.mockResolvedValue({ ...live, outlookBase: undefined });
  await expect(startOutlookCleanup({ groupIndices: [0], requestedCount: 5 })).rejects.toThrow("fresh Outlook scan");
  expect(h.state).not.toHaveBeenCalled(); expect(h.schedule).not.toHaveBeenCalled();
});
