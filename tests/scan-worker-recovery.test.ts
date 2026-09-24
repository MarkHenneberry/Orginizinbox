import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveScanSession } from "@/lib/server/live-scan-store";
import type { NormalizedMessageMetadata } from "@/lib/domain/types";

const mocks = vi.hoisted(() => ({ context: vi.fn(), save: vi.fn(), fence: vi.fn(), request: vi.fn(), close: vi.fn(),
  gmailConnection: vi.fn(),
  pages: 3, recordsPerPage: 0, pageMs: 0, clock: 0, fallback: false, failAfterPages: false }));

function records(page: number, provider: "gmail" | "microsoft"): NormalizedMessageMetadata[] {
  return Array.from({ length: mocks.recordsPerPage }, (_, index) => {
    const uid = page * mocks.recordsPerPage + index + 1;
    return { providerMessageId: `gmail-uid-${uid}`, provider, senderAddress: uid % 2 === 0 ? "protected@personal.test" : "bulk@example.test",
      receivedAt: new Date("2020-01-01"), isRead: false, isStarred: uid % 2 === 0,
      listId: "list.example.test", hasListUnsubscribe: true };
  });
}
vi.mock("@/lib/server/provider-scan-workflow-start", () => ({ startProviderScanWorkflow: vi.fn() }));
vi.mock("@/lib/server/provider-work-fence", () => ({ createScanRequestFence: () => mocks.fence }));
vi.mock("@/lib/server/live-scan-store", async (original) => ({
  ...await original<typeof import("@/lib/server/live-scan-store")>(),
  getLiveScanExecutionContext: mocks.context, setLiveScan: mocks.save
}));
vi.mock("@/lib/server/gmail-connection", () => ({ getActiveGmailConnection: mocks.gmailConnection }));
vi.mock("@/lib/server/microsoft-connection", () => ({
  getActiveMicrosoftConnection: async () => ({ accessToken: "fixture", connection: { id: "connection" } }),
  getActiveMicrosoftImapConnection: async () => ({ accessToken: "fixture", accountEmail: "fixture@example.test" }),
  forceRefreshMicrosoftConnection: vi.fn(), MicrosoftImapReconnectRequiredError: class extends Error {}
}));
vi.mock("@/lib/server/provider-request-coordinator", () => ({
  createProviderRequestCoordinator: (_id: string, options: { beforeRequest: () => Promise<void> }) =>
    async (request: () => Promise<unknown>) => { await options.beforeRequest(); return request(); }
}));
vi.mock("@/lib/providers/gmail/provider", () => ({
  GmailProvider: class {
    constructor(_token: string, _email: string, private fence: () => Promise<void>) {}
    async scanParticipatedConversationIds() {
      await this.fence(); mocks.request("participation"); return new Set();
    }
    async *scanMetadata(options: { onConnected: (value: unknown) => void }) {
      options.onConnected({ mailboxPath: "All Mail", uidValidity: "123", scalableIdentityBridgeAvailable: true });
      for (let page = 0; page < mocks.pages; page += 1) {
        await this.fence(); mocks.request("metadata"); mocks.clock += mocks.pageMs;
        const batch = records(page, "gmail");
        yield { records: batch, gmailScalableIdentities: batch.map((record, index) => {
          const uid = page * mocks.recordsPerPage + index + 1;
          return { providerMessageId: record.providerMessageId, uid, apiMessageId: uid.toString(16), scanOrdinal: uid };
        }) };
      }
    }
  }
}));
vi.mock("@/lib/providers/microsoft/imap-provider", () => ({
  outlookImapBatchSize: 250,
  OutlookImapProvider: class {
    constructor(_token: string, _email: string, private options: { beforeRequest: () => Promise<void> }) {}
    async scanParticipatedConversationIds() {
      await this.options.beforeRequest(); mocks.request("participation"); return new Set();
    }
    async *scanMetadata() {
      for (let page = 0; page < 3; page += 1) {
        await this.options.beforeRequest(); mocks.request("metadata"); yield { records: [] };
      }
    }
    getScanMetrics() { return {}; }
    close() { mocks.close(); }
  }
}));
vi.mock("@/lib/providers/microsoft/provider", () => ({
  MicrosoftProvider: class {
    constructor(_token: string, private options: { requestCoordinator: (request: () => Promise<unknown>) => Promise<unknown> }) {}
    async scanParticipatedConversationIds(input: { onFoldersResolved?: () => Promise<void> }) {
      await input.onFoldersResolved?.();
      await this.options.requestCoordinator(async () => mocks.request("participation")); return new Set();
    }
    async processMetadataWithAdaptiveFallback(input: { onBatch: (batch: { records: unknown[] }) => Promise<void>; onFallback: () => Promise<void> }) {
      for (let page = 0; page < mocks.pages; page += 1) {
        await this.options.requestCoordinator(async () => mocks.request("metadata"));
        mocks.clock += mocks.pageMs;
        await input.onBatch({ records: records(page, "microsoft") });
      }
      if (mocks.fallback) await input.onFallback();
      if (mocks.failAfterPages) throw new Error("Synthetic provider failure");
    }
    getScanMetrics() { return {}; }
  }
}));

import { runGmailBenchmark } from "@/lib/server/gmail-benchmark";
import { runMicrosoftScan } from "@/lib/server/microsoft-scan";
import { createProgress, nextExpiry } from "@/lib/server/live-scan-store";

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks, { pages: 3, recordsPerPage: 0, pageMs: 0, clock: Date.now(), fallback: false, failAfterPages: false });
  mocks.save.mockImplementation(async (_user, session: LiveScanSession) => structuredClone(session));
  mocks.gmailConnection.mockResolvedValue({ accessToken: "fixture", accountEmail: "fixture@example.test" });
  mocks.fence.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("scan performance without weaker recovery", () => {
  function run(provider: "gmail" | "microsoft") {
    const progress = createProgress({ scanId: "scan", provider, limit: "full", batchSize: 1000 });
    mocks.context.mockResolvedValue({ userId: "user", providerConnectionId: "connection", lockOwner: "worker",
      session: { progress, expiresAt: nextExpiry() } });
    vi.spyOn(Date, "now").mockImplementation(() => mocks.clock);
    return (provider === "gmail" ? runGmailBenchmark : runMicrosoftScan)({ scanId: "scan", lockOwner: "worker" });
  }

  it.each(["null", "throw"])("preserves failed scan handling when connection resolution returns %s", async (outcome) => {
    mocks.gmailConnection.mockImplementationOnce(async () => {
      if (outcome === "throw") throw new Error("Private fixture failure");
      return null;
    });
    await run("gmail");
    const final = await mocks.save.mock.results.at(-1)!.value as LiveScanSession;
    expect(final.progress.status).toBe("failed");
    expect(final.progress.errors).toHaveLength(1);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("preserves failed scan handling after an IMAP connection failure", async () => {
    mocks.fence.mockRejectedValueOnce(Object.assign(new Error("Private fixture failure"), { code: "CONNECT_TIMEOUT" }));
    await run("gmail");
    const final = await mocks.save.mock.results.at(-1)!.value as LiveScanSession;
    expect(final.progress.status).toBe("failed");
    expect(final.progress.errors).toHaveLength(1);
  });

  it("persists 24 snapshots including phases for 100 Outlook pages while fencing every page", async () => {
    Object.assign(mocks, { pages: 100, recordsPerPage: 100, pageMs: 1000 });
    await run("microsoft");
    expect(mocks.save).toHaveBeenCalledTimes(24);
    const snapshots = await Promise.all(mocks.save.mock.results.map((result) => result.value)) as LiveScanSession[];
    expect(snapshots.slice(0, 3).map(({ progress }) => [progress.phase, progress.processed])).toEqual([
      ["preparing", 0], ["sent_conversations", 0], ["messages", 0]
    ]);
    expect(mocks.fence).toHaveBeenCalledTimes(101);
    const final = await mocks.save.mock.results.at(-1)!.value as LiveScanSession;
    expect(final.progress).toMatchObject({ status: "completed", processed: 10000 });
    expect(final.report).toBeDefined();
    expect(console.info).toHaveBeenCalledWith("Outlook scan metrics", expect.objectContaining({
      credentialResolutionMs: expect.any(Number), folderResolutionMs: expect.any(Number),
      sentConversationMs: expect.any(Number), coordinationMs: expect.any(Number),
      requestMs: expect.any(Number), progressWriteMs: expect.any(Number), progressWrites: 22
    }));
    const telemetry = vi.mocked(console.info).mock.calls.at(-1)![1];
    expect(telemetry.metadataWallMs).toBeCloseTo(telemetry.metadataFetchMs + telemetry.metadataCoordinationMs +
      telemetry.metadataProgressWriteMs + telemetry.mainMessageResponseBodyJsonMs + telemetry.normalizationMs +
      telemetry.aggregatorWallMs + telemetry.metadataOtherMs, -1);
    expect(JSON.stringify(Object.values(telemetry))).not.toMatch(/fixture|connection|@|token|sender|subject|scanId|userId/i);
    expect(Object.keys(telemetry)).not.toContain("subject");
  });

  it("persists fallback reset and failure immediately inside the throttle window", async () => {
    Object.assign(mocks, { pages: 2, recordsPerPage: 100, fallback: true, failAfterPages: true });
    await run("microsoft");
    const snapshots = await Promise.all(mocks.save.mock.results.map((result) => result.value)) as LiveScanSession[];
    expect(snapshots.map(({ progress }) => [progress.status, progress.processed])).toEqual([
      ["running", 0], ["running", 0], ["running", 0], ["running", 100], ["running", 0], ["failed", 0]
    ]);
  });

  it("stops on a lost fence even while progress writes are coalesced", async () => {
    mocks.pages = 10;
    mocks.fence.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException("Lost lease", "AbortError"));
    await run("microsoft");
    expect(mocks.request.mock.calls).toEqual([["participation"], ["metadata"], ["metadata"]]);
    expect(mocks.save).toHaveBeenCalledTimes(4);
  });

  it("bounds pending Gmail identities to a batch while retaining exact eligible REST bridges", async () => {
    Object.assign(mocks, { pages: 10, recordsPerPage: 1000, pageMs: 1000 });
    await run("gmail");
    const snapshots = await Promise.all(mocks.save.mock.results.map((result) => result.value)) as LiveScanSession[];
    const final = snapshots.at(-1)!;
    expect(final.progress).toMatchObject({ status: "completed", processed: 10000,
      gmailPendingIdentityCount: 0, gmailPeakPendingIdentityCount: 1000, gmailRetainedEligibleIdentityCount: 0 });
    expect(snapshots[1].progress.gmailRetainedEligibleIdentityCount).toBe(500);
    expect(final.gmailUidValidity).toBe("123");
    expect(final.scalableCleanupTargets).toHaveLength(5000);
    expect(final.scalableCleanupTargets!.map(({ uid, apiMessageId }) => ({ uid, apiMessageId }))).toEqual(
      Array.from({ length: 5000 }, (_, index) => {
        const uid = index * 2 + 1;
        return { uid, apiMessageId: uid.toString(16) };
      })
    );
  });
});
afterEach(() => vi.restoreAllMocks());

describe.each(["gmail", "graph", "imap"] as const)("%s scan worker cancellation", (transport) => {
  function run() {
    const provider = transport === "gmail" ? "gmail" : "microsoft";
    const progress = createProgress({ scanId: "scan", provider, limit: "full", batchSize: 250 });
    progress.outlookTransport = transport === "imap" ? "imap" : "graph";
    mocks.context.mockResolvedValue({ userId: "user", providerConnectionId: "connection", lockOwner: "worker",
      session: { progress, expiresAt: nextExpiry() } });
    return (transport === "gmail" ? runGmailBenchmark : runMicrosoftScan)({ scanId: "scan", lockOwner: "worker" });
  }

  it("stops after a rejected progress write without fetching another page or publishing a report", async () => {
    mocks.save.mockImplementationOnce(async (_user, session) => session)
      .mockRejectedValueOnce(new DOMException("Ownership lost", "AbortError"));
    await run();
    expect(mocks.request.mock.calls).toEqual(transport === "graph" ? [] : [["participation"], ["metadata"]]);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls.some(([, session]) => session.report !== undefined)).toBe(false);
    if (transport === "imap") expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("stops before main metadata when ownership is lost during participation indexing", async () => {
    mocks.fence.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException("Disconnected", "AbortError"));
    await run();
    expect(mocks.request.mock.calls).toEqual([["participation"]]);
    expect(mocks.save).toHaveBeenCalledTimes(transport === "graph" ? 3 : 1);
  });

  it("does not begin provider work if the initial durable write is rejected", async () => {
    mocks.save.mockRejectedValueOnce(new DOMException("Replaced", "AbortError"));
    await expect(run()).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
