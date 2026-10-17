import { beforeEach, expect, it, vi } from "vitest";
import { DurableLiveScanStore, MemoryScanStateRepository, createProgress, nextExpiry, type LiveScanSession } from "@/lib/server/live-scan-store";
import { runDurableProviderScan } from "@/lib/server/provider-scan-runner";

const h = vi.hoisted(() => ({ store: undefined as unknown as DurableLiveScanStore, requests: [] as string[][],
  saveFailure: false, evidenceFailure: false, abort: false, calls: 0 }));
vi.mock("@/lib/server/db", () => ({ prisma: {} }));
vi.mock("@/lib/config", () => ({ env: { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"), CLEANUP_STATE_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64") }, runtimeConfig: {} }));
vi.mock("@/lib/server/live-scan-store", async original => ({
  ...await original<typeof import("@/lib/server/live-scan-store")>(),
  getLiveScanExecutionContext: (id: string) => h.store.getExecutionContext(id),
  getLiveScanById: (id: string) => h.store.getByScanId(id),
  claimLiveScan: (id: string, owner: string) => h.store.claim(id, owner),
  releaseLiveScan: (id: string, owner: string) => h.store.release(id, owner),
  setLiveScan: async (user: string, session: LiveScanSession, provider: "microsoft", owner: string) => {
    if (session.outlookProgressive && h.saveFailure) { h.saveFailure = false; throw new Error("storage interruption"); }
    const saved = await h.store.set(user, session, provider, owner);
    if (!saved) throw new DOMException("Lost lease", "AbortError");
    return saved;
  }
}));
vi.mock("@/lib/server/gmail-benchmark", () => ({ runGmailBenchmark: vi.fn() }));
vi.mock("@/lib/server/provider-scan-workflow-start", () => ({ startProviderScanWorkflow: vi.fn() }));
vi.mock("@/lib/server/microsoft-connection", () => ({ getActiveMicrosoftConnection: async () => ({ accessToken: "fixture", connection: { id: "connection" } }), forceRefreshMicrosoftConnection: vi.fn() }));
vi.mock("@/lib/server/provider-request-coordinator", () => ({ createProviderRequestCoordinator: () => async (request: () => Promise<unknown>) => request() }));
vi.mock("@/lib/providers/microsoft/provider", () => ({ MicrosoftProvider: class {
  async scanParticipatedConversationIds(input: { onFoldersResolved?: () => Promise<void> }) { await input.onFoldersResolved?.(); return new Set(["participated"]); }
  async processMetadataWithAdaptiveFallback(input: { baseOnly?: boolean; onBatch: (batch: { records: unknown[] }) => Promise<void> }) {
    expect(input.baseOnly).toBe(true);
    await input.onBatch({ records: Array.from({ length: 241 }, (_, index) => ({ provider: "microsoft", providerMessageId: `private-message-${index}`,
      senderAddress: "private-sender@example.test", receivedAt: new Date("2020-01-01"), isRead: false, hasListUnsubscribe: false,
      ...(index === 240 ? { conversationId: "participated" } : {}) })) });
  }
  async getHeaderEvidence(ids: string[]) {
    if (h.abort) throw new DOMException("Lost authorization", "AbortError");
    h.requests.push(ids); h.calls++;
    if (h.evidenceFailure) throw new Error("private provider failure");
    return ids.map(() => ({ hasListUnsubscribe: true, listId: "private-header-value", precedence: "bulk" }));
  }
  getScanMetrics() { return { requests: h.calls, retries: 0, graphPages: 1 }; }
} }));

let repository: MemoryScanStateRepository;
beforeEach(async () => {
  vi.restoreAllMocks(); vi.spyOn(console, "info").mockImplementation(() => undefined);
  Object.assign(h, { requests: [], saveFailure: false, evidenceFailure: false, abort: false, calls: 0 });
  repository = new MemoryScanStateRepository(); h.store = new DurableLiveScanStore(repository);
  await h.store.accept({ userId: "user", providerConnectionId: "connection", session: {
    progress: createProgress({ scanId: "scan", provider: "microsoft", batchSize: 250, limit: "full" }), expiresAt: nextExpiry()
  } });
});
it("makes the durable base report usable before enrichment, resumes after replacement, and ignores duplicate completed Workflow calls", async () => {
  expect(await runDurableProviderScan("scan")).toEqual({ outcome: "continue" });
  const base = (await h.store.getByScanId("scan"))!;
  expect(base.report?.totals).toMatchObject({ messages: 241, cleanupCandidates: 0, protectedMessages: 1 });
  expect(base.progress.reportUsableMs).toEqual(expect.any(Number)); expect(h.requests).toHaveLength(0);
  const row = (await repository.findByScanId("scan"))!;
  expect(row.encryptedPayload).not.toMatch(/private-message|private-sender|participated/);
  h.store = new DurableLiveScanStore(repository);
  expect(await runDurableProviderScan("scan")).toEqual({ outcome: "continue" });
  const partial = (await h.store.getByScanId("scan"))!;
  expect(partial.progress.outlookVerification).toMatchObject({ candidates: 240, checked: 200 });
  expect(partial.report?.totals).toMatchObject({ messages: 241, cleanupCandidates: 200, protectedMessages: 1, reviewMessages: 40 });
  expect(h.requests).toHaveLength(10); expect(h.requests.every(ids => ids.length <= 20)).toBe(true);
  h.store = new DurableLiveScanStore(repository);
  expect(await runDurableProviderScan("scan")).toEqual({ outcome: "completed" });
  const final = (await h.store.getByScanId("scan"))!;
  expect(final.report?.totals).toMatchObject({ messages: 241, cleanupCandidates: 240, protectedMessages: 1 });
  expect(final.progress.outlookVerification?.status).toBe("complete");
  const count = h.requests.length;
  expect(await runDurableProviderScan("scan")).toEqual({ outcome: "not_running" });
  expect(h.requests).toHaveLength(count);
  expect(new Set(h.requests.flat()).size).toBe(240);
  expect(JSON.stringify(final.outlookProgressive)).not.toContain("private-header-value");
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/private-message|private-sender|private-header/);
});
it("retries read-only work after an interrupted checkpoint without double counting", async () => {
  await runDurableProviderScan("scan"); h.saveFailure = true;
  await expect(runDurableProviderScan("scan")).rejects.toThrow("storage interruption");
  expect((await h.store.getByScanId("scan"))!.report?.totals.cleanupCandidates).toBe(0);
  h.store = new DurableLiveScanStore(repository);
  await runDurableProviderScan("scan"); await runDurableProviderScan("scan");
  expect((await h.store.getByScanId("scan"))!.report?.totals).toMatchObject({ messages: 241, cleanupCandidates: 240 });
});
it("preserves the base report on enrichment outage and leaves all unavailable targets Review", async () => {
  await runDurableProviderScan("scan"); h.evidenceFailure = true;
  expect(await runDurableProviderScan("scan")).toEqual({ outcome: "completed" });
  const final = (await h.store.getByScanId("scan"))!;
  expect(final.progress.outlookVerification?.status).toBe("unavailable");
  expect(final.report?.totals).toMatchObject({ cleanupCandidates: 0, reviewMessages: 240, protectedMessages: 1 });
});
it("never continues later requests after loss of durable authorization", async () => {
  await runDurableProviderScan("scan"); h.abort = true;
  expect(await runDurableProviderScan("scan")).toEqual({ outcome: "stopped" });
  expect(h.requests).toHaveLength(0);
  expect((await h.store.getByScanId("scan"))!.report?.totals.cleanupCandidates).toBe(0);
});
it("stops verification after cleanup marks the report stale without clearing the report or recovery context", async () => {
  await runDurableProviderScan("scan");
  await h.store.update("user", "microsoft", session => { session.reportStale = true; });
  await runDurableProviderScan("scan");
  const final = (await h.store.getByScanId("scan"))!;
  expect(final.reportStale).toBe(true); expect(final.report).toBeDefined();
  expect(final.progress.outlookVerification?.status).toBe("unavailable"); expect(h.requests).toHaveLength(0);
});
it("a stale worker snapshot cannot erase concurrent cleanup invalidation", async () => {
  await runDurableProviderScan("scan");
  await h.store.claim("scan", "worker");
  const staleSnapshot = (await h.store.getByScanId("scan"))!;
  await h.store.update("user", "microsoft", session => { session.reportStale = true; });
  await h.store.set("user", staleSnapshot, "microsoft", "worker");
  expect((await h.store.getByScanId("scan"))!.reportStale).toBe(true);
});
