import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient, type ProviderConnection } from "@prisma/client";
import { prisma } from "@/lib/server/db";
import { encryptSecret, decryptSecret } from "@/lib/server/crypto";
import { DurableLiveScanStore, PrismaScanStateRepository, type LiveScanSession } from "@/lib/server/live-scan-store";
import { PrismaCleanupJobStore, PrismaCleanupJobStateRepository } from "@/lib/server/cleanup-job-store";
import { createPrismaGmailScalableCleanupStore } from "@/lib/server/gmail-scalable-cleanup-durable-store";
import { createPrismaOutlookCleanupStore } from "@/lib/server/outlook-cleanup-store";
import { acceptDurableGmailScalableCleanup, confirmDurableGmailScalableCleanup, undoDurableGmailScalableCleanup } from "@/lib/server/gmail-scalable-live-workflow";
import { startOutlookCleanup, confirmOutlookCleanup, advanceOutlookCleanupJob, undoOutlookCleanup } from "@/lib/server/outlook-cleanup";
import { createGmailScalableWorkflowCoordinator } from "@/lib/server/gmail-scalable-workflow-coordinator";
import { refreshProviderConnectionSingleFlight } from "@/lib/server/provider-token-refresh";
import { createScanRequestFence, createCleanupRequestFence } from "@/lib/server/provider-work-fence";
import { disconnectCurrentProviderSession } from "@/lib/server/disconnect";
import { MicrosoftProvider } from "@/lib/providers/microsoft/provider";
import type { GmailScalableCleanupTarget } from "@/lib/providers/gmail/scalable-targets";
import { GmailScalableCleanupProvider, type GmailScalableVerificationResult } from "@/lib/providers/gmail/scalable-cleanup-provider";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import { buildCleanupSenderGroups } from "@/lib/providers/gmail/cleanup-candidates";
import { postgresAuth } from "./fixtures/postgres-auth";

const scheduling = vi.hoisted(() => ({ gmail: vi.fn(async () => "test-run"), outlook: vi.fn(async () => "test-run") }));
vi.mock("@/lib/server/session", async () => {
  const { postgresAuth } = await import("./fixtures/postgres-auth");
  return { getSession: async () => postgresAuth.getStore() ?? null, clearSessionCookie: async () => {}, clearOAuthStateCookie: async () => {} };
});
vi.mock("@/lib/server/gmail-scalable-workflow-start", () => ({ startGmailScalableCleanupWorkflow: scheduling.gmail, startGmailScalableUndoWorkflow: scheduling.gmail }));
vi.mock("@/lib/server/provider-cleanup-workflow-start", () => ({ startProviderCleanupWorkflow: scheduling.outlook }));

const runPrefix = `pg-proof-${randomUUID()}`;
const users: string[] = [];
const second = new PrismaClient();
const scanA = new DurableLiveScanStore(new PrismaScanStateRepository(prisma));
const scanB = new DurableLiveScanStore(new PrismaScanStateRepository(second));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const record = (id: string, provider: "gmail" | "microsoft" = "microsoft") => ({
  providerMessageId: id, provider, senderAddress: "synthetic@postgres.example.test",
  receivedAt: new Date("2020-01-01"), isRead: false, listId: "synthetic.postgres.test", hasListUnsubscribe: true
});
const asUser = <T>(connection: ProviderConnection, task: () => Promise<T>) => postgresAuth.run({ userId: connection.userId, providerConnectionId: connection.id }, task);

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; await second.$queryRaw`SELECT 1`; }
  catch { throw new Error("Development Postgres connection unavailable; no provider fallback is allowed."); }
});
afterAll(async () => {
  try {
    if (users.some((id) => !id.startsWith(`${runPrefix}-`))) throw new Error("Test cleanup ownership check failed.");
    if (users.length) {
      const scans = await prisma.scan.findMany({ where: { userId: { in: users } }, select: { id: true, cleanupJobs: { select: { id: true } } } });
      const jobs = scans.flatMap((scan) => scan.cleanupJobs.map((job) => job.id));
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      expect(await prisma.user.count({ where: { id: { in: users } } })).toBe(0);
      expect(await prisma.scanState.count({ where: { userId: { in: users } } })).toBe(0);
      expect(await prisma.cleanupJobState.count({ where: { userId: { in: users } } })).toBe(0);
      expect(await prisma.providerConnection.count({ where: { userId: { in: users } } })).toBe(0);
      expect(await prisma.scan.count({ where: { id: { in: scans.map((scan) => scan.id) } } })).toBe(0);
      expect(await prisma.cleanupJob.count({ where: { id: { in: jobs } } })).toBe(0);
      console.info("Postgres proof cleanup: all temporary users and dependent states removed.");
    }
  } finally { await second.$disconnect(); await prisma.$disconnect(); }
});

async function newUser() {
  const id = `${runPrefix}-${users.length}`;
  users.push(id);
  await prisma.user.create({ data: { id } });
  return id;
}
async function connection(userId: string, provider: "gmail" | "microsoft") {
  return prisma.providerConnection.create({ data: { userId, provider, sessionGeneration: randomUUID(),
    encryptedAccessToken: encryptSecret("synthetic-access"), encryptedRefreshToken: encryptSecret("synthetic-refresh"),
    encryptedAccountEmail: encryptSecret("synthetic@postgres.example.test"),
    scope: provider === "gmail" ? "https://mail.google.com/" : "Mail.ReadWrite", tokenExpiresAt: new Date(Date.now() + 3600_000) } });
}
function session(provider: "gmail" | "microsoft", completed = false, count = 250): LiveScanSession {
  const aggregator = new StreamingReportAggregator({ participatedConversationIds: new Set() });
  aggregator.processBatch(Array.from({ length: count }, (_, i) => record(`synthetic-message-${i}`, provider)));
  return { progress: { scanId: randomUUID(), provider, status: completed ? "completed" : "running", limit: "full", batchSize: 100,
    processed: completed ? count : 0, startedAt: Date.now(), duplicateStartCount: 0, errors: [], notes: [] },
    report: completed ? aggregator.snapshot(provider, false) : undefined,
    participatedConversationIds: new Set(), expiresAt: Date.now() + 3600_000 };
}
async function newScan(c: ProviderConnection, completed = false, count = 250) {
  return (await scanA.accept({ userId: c.userId, providerConnectionId: c.id, session: session(c.provider, completed, count) })).session;
}
async function gmailJob(c: ProviderConnection, existingScan?: LiveScanSession) {
  const scan = existingScan ?? await newScan(c, true);
  const targets: GmailScalableCleanupTarget[] = Array.from({ length: 250 }, (_, i) => ({ uid: i + 1, apiMessageId: `synthetic-gmail-${i}`,
    groupIndex: 0, immutableEvidence: { eligibleAtScan: true, subjectProtected: false, participatedConversation: false,
      protectedAtScan: false, ageBand: "very_old", cleanupSignals: [] } }));
  return acceptDurableGmailScalableCleanup({ userId: c.userId, providerConnectionId: c.id, scanId: scan.progress.scanId,
    uidValidity: "1", requestedCount: 250, groupIndices: [0], groups: buildCleanupSenderGroups(scan.report!.senders), targets });
}
async function outlookJob(c: ProviderConnection, count = 10) {
  await newScan(c, true, count);
  return asUser(c, () => startOutlookCleanup({ groupIndices: [0], requestedCount: count }));
}

describe.sequential("actual Postgres durability and isolation", () => {
  it("atomically accepts same-user scans while unrelated users/providers remain independent", async () => {
    const u = await newUser(), other = await newUser();
    const g = await connection(u, "gmail"), m = await connection(u, "microsoft"), g2 = await connection(other, "gmail");
    const [a, b, independent, otherProvider] = await Promise.all([
      scanA.accept({ userId: u, providerConnectionId: g.id, session: session("gmail") }),
      scanB.accept({ userId: u, providerConnectionId: g.id, session: session("gmail") }),
      scanB.accept({ userId: other, providerConnectionId: g2.id, session: session("gmail") }),
      scanA.accept({ userId: u, providerConnectionId: m.id, session: session("microsoft") })
    ]);
    expect(a.session.progress.scanId).toBe(b.session.progress.scanId);
    expect([a, b].filter((value) => !value.reused)).toHaveLength(1);
    expect(independent.reused).toBe(false); expect(otherProvider.reused).toBe(false);
    expect(await prisma.scan.count({ where: { userId: u, provider: "gmail" } })).toBe(1);
    expect(await prisma.scanState.count({ where: { userId: { in: [u, other] } } })).toBe(3);
  });

  it("atomically accepts duplicate Gmail and Outlook jobs using the real acceptance transactions", async () => {
    const u = await newUser();
    const g = await connection(u, "gmail"), m = await connection(u, "microsoft");
    const gs = await newScan(g, true), ms = await newScan(m, true, 10);
    const other = await connection(await newUser(), "gmail"), otherScan = await newScan(other, true);
    const results = await Promise.allSettled([
      gmailJob(g, gs), gmailJob(g, gs),
      asUser(m, () => startOutlookCleanup({ groupIndices: [0], requestedCount: 10 })),
      asUser(m, () => startOutlookCleanup({ groupIndices: [0], requestedCount: 10 })), gmailJob(other, otherScan)
    ]);
    expect(results.map((r) => r.status === "rejected" ? (r.reason as { code?: string }).code ?? "error" : "accepted"))
      .toEqual(["accepted", "accepted", "accepted", "accepted", "accepted"]);
    const ids = results.map((r) => r.status === "fulfilled" ? r.value.id : "");
    expect(ids[0]).toBe(ids[1]); expect(ids[2]).toBe(ids[3]); expect(ids[0]).not.toBe(ids[2]);
    expect(new Set(ids).size).toBe(3);
    expect(await prisma.cleanupJob.count({ where: { scanId: { in: [gs.progress.scanId, ms.progress.scanId] } } })).toBe(2);
    expect(await prisma.cleanupJobState.count({ where: { userId: u } })).toBe(2);
  });

  it("reclaims expired scan ownership across clients and rejects stale worker progress", async () => {
    const c = await connection(await newUser(), "gmail"), live = await newScan(c);
    const id = live.progress.scanId;
    const a = new PrismaScanStateRepository(prisma), b = new PrismaScanStateRepository(second);
    expect(await a.claim({ scanId: id, owner: "A", now: new Date(), lockExpiresAt: new Date(Date.now() + 60_000) })).toBe(true);
    expect(await b.claim({ scanId: id, owner: "B", now: new Date(), lockExpiresAt: new Date(Date.now() + 60_000) })).toBe(false);
    // Fault injection only on this test-owned lease simulates elapsed downtime.
    await prisma.scanState.update({ where: { scanId: id }, data: { lockExpiresAt: new Date(Date.now() - 1) } });
    expect(await b.claim({ scanId: id, owner: "B", now: new Date(), lockExpiresAt: new Date(Date.now() + 60_000) })).toBe(true);
    const persisted = await second.scanState.findUniqueOrThrow({ where: { scanId: id } });
    expect(await a.replace({ userId: c.userId, provider: "gmail", scanId: id, expectedVersion: persisted.version,
      encryptedPayload: persisted.encryptedPayload, status: "completed", expiresAt: persisted.expiresAt, lockOwner: "A" })).toBe(false);
    live.progress.processed = 5;
    expect(await scanA.set(c.userId, live, "gmail", "A")).toBeUndefined();
    expect(await scanB.set(c.userId, live, "gmail", "B")).toBeDefined();
    expect(await a.release(id, "A")).toBe(false);
    expect((await scanA.get(c.userId, "gmail"))?.progress.processed).toBe(5);
  });

  it("fences competing cleanup leases and stale CAS across independent clients", async () => {
    const c = await connection(await newUser(), "gmail"), job = await gmailJob(c);
    const a = createPrismaGmailScalableCleanupStore();
    const b = new PrismaCleanupJobStore(new PrismaCleanupJobStateRepository(second));
    const current = await a.claim(job.id, "A"); expect(current).toBeDefined();
    expect(await b.claim(job.id, "B")).toBeUndefined();
    await prisma.cleanupJobState.update({ where: { jobId: job.id }, data: { lockExpiresAt: new Date(Date.now() - 1) } });
    expect(await b.claim(job.id, "B")).toBeDefined();
    expect(await a.compareAndSet(c.userId, job.id, current!.version, (j) => j, new Date(), "A")).toBeUndefined();
    expect(await b.compareAndSet(c.userId, job.id, current!.version, (j) => j, new Date(), "B")).toBeDefined();
    expect(await a.compareAndSet(c.userId, job.id, current!.version, (j) => j)).toBeUndefined();
    expect(await a.releaseLock(job.id, "A")).toBe(false);
    expect(await a.get("not-the-owner", job.id)).toBeUndefined();
  });

  it.each(["gmail", "microsoft"] as const)("disconnect fences %s without altering the other provider", async (provider) => {
    const u = await newUser(), g = await connection(u, "gmail"), m = await connection(u, "microsoft");
    const gj = await gmailJob(g), mj = await outlookJob(m);
    const gs = await newScan(g), ms = await newScan(m);
    const selected = provider === "gmail" ? g : m, retained = provider === "gmail" ? m : g;
    const scanId = provider === "gmail" ? gs.progress.scanId : ms.progress.scanId;
    const jobId = provider === "gmail" ? gj.id : mj.id, retainedJob = provider === "gmail" ? mj.id : gj.id;
    const repo = new PrismaScanStateRepository(prisma);
    await repo.claim({ scanId, owner: "old", now: new Date(), lockExpiresAt: new Date(Date.now() + 60_000) });
    const store = new PrismaCleanupJobStore();
    const oldJob = await store.claim(jobId, "old");
    await asUser(selected, disconnectCurrentProviderSession);
    expect((await prisma.providerConnection.findUniqueOrThrow({ where: { id: selected.id } })).encryptedAccessToken).toBeNull();
    expect((await prisma.providerConnection.findUniqueOrThrow({ where: { id: retained.id } })).disconnectedAt).toBeNull();
    expect((await prisma.scan.findUniqueOrThrow({ where: { id: scanId } })).status).toBe("cancelled");
    expect(await scanA.get(u, provider)).toBeUndefined();
    expect(await scanA.get(u, retained.provider)).toBeDefined();
    expect(await store.get(u, jobId)).toBeUndefined(); expect(await store.get(u, retainedJob)).toBeDefined();
    expect(await store.compareAndSet(u, jobId, oldJob!.version, (j) => j, new Date(), "old")).toBeUndefined();
    expect(await repo.claim({ scanId, owner: "new", now: new Date(), lockExpiresAt: new Date(Date.now() + 60_000) })).toBe(false);
    await expect(createScanRequestFence(scanId, "old", provider)()).rejects.toMatchObject({ name: "AbortError" });
    await expect(createCleanupRequestFence(selected, jobId, "old")()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("single-flights rotated credentials and rejects a stale refresh after lease replacement", async () => {
    const c = await connection(await newUser(), "microsoft");
    const refresh = vi.fn(async () => { await wait(30); return { accessToken: "rotated-A", refreshToken: "rotated-R", tokenExpiresAt: new Date(Date.now() + 3600_000) }; });
    const input = { userId: c.userId, connection: c, provider: c.provider, force: true, refreshSkewMs: 60_000, refresh };
    const [a, b] = await Promise.all([refreshProviderConnectionSingleFlight({ ...input, client: prisma }), refreshProviderConnectionSingleFlight({ ...input, client: second })]);
    expect(refresh).toHaveBeenCalledTimes(1); expect(a.tokenVersion).toBe(1); expect(b.tokenVersion).toBe(1);
    expect(decryptSecret(b.encryptedRefreshToken!)).toBe("rotated-R");
    let release!: () => void;
    const stale = refreshProviderConnectionSingleFlight({ ...input, connection: a, client: prisma, refresh: async () => {
      await new Promise<void>((resolve) => { release = resolve; }); return { accessToken: "stale", refreshToken: "stale" };
    } }).then(() => "committed", () => "rejected");
    await vi.waitFor(() => expect(release).toBeDefined());
    try {
      await second.providerConnection.update({ where: { id: c.id }, data: { refreshLeaseExpiresAt: new Date(Date.now() - 1) } });
      await refreshProviderConnectionSingleFlight({ ...input, connection: a, client: second });
    } finally { release(); }
    expect(await stale).toBe("rejected");
    const latest = await second.providerConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(latest.tokenVersion).toBe(2); expect(decryptSecret(latest.encryptedAccessToken!)).toBe("rotated-A");
  });

  it("does not let an in-flight refresh restore credentials after real disconnect", async () => {
    const c = await connection(await newUser(), "gmail");
    let release!: () => void;
    const pending = refreshProviderConnectionSingleFlight({ userId: c.userId, connection: c, provider: c.provider,
      force: true, refreshSkewMs: 60_000, client: second, refresh: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { accessToken: "must-not-survive", refreshToken: "must-not-survive" };
      } }).then(() => "committed", () => "rejected");
    await vi.waitFor(() => expect(release).toBeDefined());
    try { await asUser(c, disconnectCurrentProviderSession); }
    finally { release(); }
    expect(await pending).toBe("rejected");
    const persisted = await prisma.providerConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(persisted.encryptedAccessToken).toBeNull(); expect(persisted.encryptedRefreshToken).toBeNull();
    expect(persisted.disconnectedAt).not.toBeNull(); expect(persisted.tokenVersion).toBe(1);
  });

  it("re-enters the real Gmail coordinator/executor after dispatch loss without replaying mutation", async () => {
    const c = await connection(await newUser(), "gmail"), accepted = await gmailJob(c);
    const store = createPrismaGmailScalableCleanupStore();
    const moved = new Set<string>(), restored: string[] = [];
    const fence = createCleanupRequestFence(c, accepted.id);
    const spies = [
      vi.spyOn(GmailScalableCleanupProvider.prototype, "runSafetyCheck").mockImplementation(async ({ targets }) => {
        await fence();
        return { safeTargets: [...targets], missingCount: 0, identityMismatchCount: 0, starredCount: 0, importantCount: 0,
          trashCount: 0, sentCount: 0, draftCount: 0, personalCount: 0, personalListRequests: 1, retryCount: 0, imapMs: 0, personalMs: 0 };
      }),
      vi.spyOn(GmailScalableCleanupProvider.prototype, "captureHistoryCheckpoint").mockImplementation(async () => { await fence(); return "synthetic-checkpoint"; }),
      vi.spyOn(GmailScalableCleanupProvider.prototype, "moveToTrash").mockImplementation(async (ids) => {
        await fence(); ids.forEach((id) => moved.add(id));
        throw new Error("Injected loss after synthetic provider dispatch");
      }),
      vi.spyOn(GmailScalableCleanupProvider.prototype, "verifyTrash").mockImplementation(async ({ targetIds }) => {
        await fence(); expect(targetIds.every((id) => moved.has(id))).toBe(true); return verified(targetIds);
      }),
      vi.spyOn(GmailScalableCleanupProvider.prototype, "removeTrashLabel").mockImplementation(async (ids) => { await fence(); restored.push(...ids); }),
      vi.spyOn(GmailScalableCleanupProvider.prototype, "verifyTrashRemoval").mockImplementation(async ({ targetIds }) => {
        await fence(); expect(targetIds.every((id) => restored.includes(id))).toBe(true); return verified(targetIds);
      })
    ];
    try {
      await createGmailScalableWorkflowCoordinator().advance(accepted.id, "cleanup");
      expect((await store.get(c.userId, accepted.id))?.view.status).toBe("ready");
      scheduling.gmail.mockRejectedValueOnce(new Error("Injected scheduler failure"));
      await expect(confirmDurableGmailScalableCleanup(c.userId, accepted.id)).rejects.toThrow("scheduler failure");
      await confirmDurableGmailScalableCleanup(c.userId, accepted.id);
      await createGmailScalableWorkflowCoordinator().advance(accepted.id, "cleanup");
      await createGmailScalableWorkflowCoordinator().advance(accepted.id, "cleanup");
      await expect(createGmailScalableWorkflowCoordinator().advance(accepted.id, "cleanup")).rejects.toThrow("dispatch");
      expect((await store.get(c.userId, accepted.id))?.payload.chunks[0].trashMutationDispatched).toBe(true);
      // A new coordinator and a freshly decoded Postgres ledger must verify, not resend.
      const recovered = await createGmailScalableWorkflowCoordinator().advance(accepted.id, "cleanup");
      expect(recovered.operation).toBe("verify_trash");
      for (let i = 0; i < 3 && (await store.get(c.userId, accepted.id))?.view.status !== "complete"; i++) {
        await createGmailScalableWorkflowCoordinator().advance(accepted.id, "cleanup");
      }
      expect((await store.get(c.userId, accepted.id))?.view.verifiedCount).toBe(250);
      expect(spies[2]).toHaveBeenCalledTimes(1);
      await undoDurableGmailScalableCleanup(c.userId, accepted.id);
      for (let i = 0; i < 5 && await store.get(c.userId, accepted.id); i++) {
        await createGmailScalableWorkflowCoordinator().advance(accepted.id, "undo");
      }
      expect(new Set(restored)).toEqual(moved); expect(restored).toHaveLength(250);
      expect(await store.get(c.userId, accepted.id)).toBeUndefined();
      const aggregate = await prisma.cleanupJob.findUniqueOrThrow({ where: { id: accepted.id } });
      expect(aggregate.terminalState).toBe("undo_complete");
      expect(JSON.stringify(aggregate)).not.toMatch(/synthetic-gmail-|synthetic-checkpoint|synthetic@/);
    } finally { spies.forEach((spy) => spy.mockRestore()); }
  });

  it("re-enters the real Outlook runner and restores only its durable verified ledger after uncertainty", async () => {
    const c = await connection(await newUser(), "microsoft"), accepted = await outlookJob(c, 10);
    const fence = createCleanupRequestFence(c, accepted.id);
    let forwardCalls = 0;
    const undoInputs: Array<{ messageId: string; destinationFolderId: string }> = [];
    const spies = [
      vi.spyOn(MicrosoftProvider.prototype, "scanMetadata").mockImplementation(async function* () {
        await fence(); yield { records: Array.from({ length: 10 }, (_, i) => record(`synthetic-outlook-${i}`)) };
      }),
      vi.spyOn(MicrosoftProvider.prototype, "scanParticipatedConversationIds").mockImplementation(async () => { await fence(); return new Set(); }),
      vi.spyOn(MicrosoftProvider.prototype, "getCleanupSafetyContext").mockImplementation(async () => {
        await fence(); return { knownFolderIds: ["synthetic-inbox", "synthetic-deleted"], kindByFolderId: [], sentFolderIds: [], deletedItemsFolderId: "synthetic-deleted" };
      }),
      vi.spyOn(MicrosoftProvider.prototype, "getCleanupMessages").mockImplementation(async (ids) => {
        await fence(); return ids.map((id) => ({ record: record(id), parentFolderId: "synthetic-inbox" }));
      }),
      vi.spyOn(MicrosoftProvider.prototype, "moveCleanupMessages").mockImplementation(async (inputs, operation) => {
        await fence();
        if (operation === "cleanup_move" && ++forwardCalls === 2) throw new Error("Injected ambiguous synthetic move");
        if (operation !== "cleanup_move") undoInputs.push(...inputs);
        return inputs.map(({ messageId }) => ({ outcome: "success" as const, messageId: `${operation === "cleanup_move" ? "moved" : "restored"}-${messageId}` }));
      }),
      vi.spyOn(MicrosoftProvider.prototype, "verifyCleanupMessageLocations").mockImplementation(async (inputs) => { await fence(); return inputs.map(() => true); })
    ];
    try {
      await advanceOutlookCleanupJob(accepted.id, "prepare");
      scheduling.outlook.mockRejectedValueOnce(new Error("Injected scheduler failure"));
      await expect(asUser(c, () => confirmOutlookCleanup(accepted.id))).rejects.toThrow("scheduler failure");
      await asUser(c, () => confirmOutlookCleanup(accepted.id));
      expect((await advanceOutlookCleanupJob(accepted.id, "cleanup")).outcome).toBe("continue");
      await advanceOutlookCleanupJob(accepted.id, "cleanup");
      const durable = await createPrismaOutlookCleanupStore().get(c.userId, accepted.id);
      expect(durable?.view).toMatchObject({ status: "uncertain", movedVerified: 5, uncertain: 5, undoAvailable: true });
      await advanceOutlookCleanupJob(accepted.id, "cleanup");
      expect(forwardCalls).toBe(2);
      const persisted = await prisma.cleanupJobState.findUniqueOrThrow({ where: { jobId: accepted.id } });
      expect(persisted.encryptedPayload).not.toMatch(/synthetic-outlook|synthetic-inbox|synthetic@/);
      await asUser(c, () => undoOutlookCleanup(accepted.id));
      await advanceOutlookCleanupJob(accepted.id, "undo");
      await advanceOutlookCleanupJob(accepted.id, "undo");
      expect(undoInputs).toEqual(Array.from({ length: 5 }, (_, i) => ({ messageId: `moved-synthetic-outlook-${i}`, destinationFolderId: "synthetic-inbox" })));
      expect((await createPrismaOutlookCleanupStore().get(c.userId, accepted.id))?.view)
        .toMatchObject({ status: "uncertain", undoStatus: "uncertain", restoredVerified: 5, uncertain: 5 });
      const aggregate = await prisma.cleanupJob.findUniqueOrThrow({ where: { id: accepted.id } });
      expect(aggregate.status).toBe("partial");
      expect(JSON.stringify(aggregate)).not.toMatch(/synthetic-outlook|synthetic-inbox|synthetic@/);
    } finally { spies.forEach((spy) => spy.mockRestore()); }
  });
});

function verified(ids: readonly string[]): GmailScalableVerificationResult {
  return { verifiedIds: [...ids], failedIds: [], uncertainIds: [], historyVerifiedCount: ids.length, listVerifiedCount: 0,
    getVerifiedCount: 0, historyRequests: 1, historyPages: 1, historyPollAttempts: 1, listRequests: 0, listPages: 0,
    getFallbackRequests: 0, retryCount: 0, historyUnavailable: false, durationMs: 0 };
}
