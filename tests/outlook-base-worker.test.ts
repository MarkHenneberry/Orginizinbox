import { beforeEach, expect, it, vi } from "vitest";
import { DurableLiveScanStore, MemoryScanStateRepository, createProgress, nextExpiry, type LiveScanSession } from "@/lib/server/live-scan-store";
import { runDurableProviderScan } from "@/lib/server/provider-scan-runner";
const h = vi.hoisted(() => ({ store: undefined as unknown as DurableLiveScanStore, scans: 0, headerReads: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: {} }));
vi.mock("@/lib/config", () => ({ env: { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"), CLEANUP_STATE_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64") }, runtimeConfig: {} }));
vi.mock("@/lib/server/live-scan-store", async original => ({ ...await original<typeof import("@/lib/server/live-scan-store")>(),
  getLiveScanExecutionContext: (id: string) => h.store.getExecutionContext(id), getLiveScanById: (id: string) => h.store.getByScanId(id),
  claimLiveScan: (id: string, owner: string) => h.store.claim(id, owner), releaseLiveScan: (id: string, owner: string) => h.store.release(id, owner),
  setLiveScan: async (user: string, session: LiveScanSession, provider: "microsoft", owner: string) => {
    if (!await h.store.set(user, session, provider, owner)) throw new DOMException("Lost lease", "AbortError");
  }
}));
vi.mock("@/lib/server/gmail-benchmark", () => ({ runGmailBenchmark: vi.fn() }));
vi.mock("@/lib/server/provider-scan-workflow-start", () => ({ startProviderScanWorkflow: vi.fn() }));
vi.mock("@/lib/server/microsoft-connection", () => ({ getActiveMicrosoftConnection: async () => ({ accessToken: "fixture", connection: { id: "connection" } }), forceRefreshMicrosoftConnection: vi.fn() }));
vi.mock("@/lib/server/provider-request-coordinator", () => ({ createProviderRequestCoordinator: () => async (request: () => Promise<unknown>) => request() }));
vi.mock("@/lib/providers/microsoft/provider", () => ({ MicrosoftProvider: class {
  async scanParticipatedConversationIds(input: { onFoldersResolved?: () => Promise<void> }) { await input.onFoldersResolved?.(); return new Set(["participated"]); }
  async processMetadataWithAdaptiveFallback(input: { baseOnly?: boolean; onBatch: (batch: { records: unknown[] }) => Promise<void> }) {
    expect(input.baseOnly).toBe(true); h.scans++;
    await input.onBatch({ records: Array.from({ length: 31 }, (_, index) => ({ provider: "microsoft", providerMessageId: `private-message-${index}`,
      senderAddress: "private-sender@example.test", receivedAt: new Date("2020-01-01"), isRead: false,
      ...(index === 30 ? { conversationId: "participated" } : {}) })) });
  }
  getHeaderEvidence = h.headerReads;
  getEnrichmentCollectionPage = h.headerReads;
  getScanMetrics() { return { requests: 1, graphPages: 1 }; }
} }));
let repository: MemoryScanStateRepository;
beforeEach(async () => {
  vi.restoreAllMocks(); vi.spyOn(console, "info").mockImplementation(() => undefined); h.scans = 0; h.headerReads.mockClear();
  repository = new MemoryScanStateRepository(); h.store = new DurableLiveScanStore(repository);
  await h.store.accept({ userId: "user", providerConnectionId: "connection", session: {
    progress: createProgress({ scanId: "scan", provider: "microsoft", batchSize: 250, limit: "full" }), expiresAt: nextExpiry()
  } });
});
it("completes after base metadata, retains encrypted exact IDs, and never starts automatic header work after replacement", async () => {
  expect(await runDurableProviderScan("scan")).toEqual({ outcome: "completed" });
  const final = (await h.store.getByScanId("scan"))!;
  expect(final.report?.totals).toMatchObject({ messages: 31, cleanupCandidates: 0, potentialCleanup: 30, protectedMessages: 1 });
  expect(final.progress).toMatchObject({ status: "completed", reportUsableMs: expect.any(Number) });
  expect(final.outlookBase?.records).toHaveLength(31);
  expect((await repository.findByScanId("scan"))!.encryptedPayload).not.toMatch(/private-message|private-sender|participated/);
  h.store = new DurableLiveScanStore(repository);
  expect(await runDurableProviderScan("scan")).toEqual({ outcome: "not_running" });
  expect(h.scans).toBe(1); expect(h.headerReads).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/private-message|private-sender/);
});
