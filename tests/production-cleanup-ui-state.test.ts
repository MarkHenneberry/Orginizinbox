import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connection: vi.fn(), find: vi.fn(), entitlement: vi.fn(), infrastructure: vi.fn(),
  access: vi.fn(), gmail: vi.fn(), outlook: vi.fn(), report: vi.fn(), redirectReport: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: { cleanupJobState: { findFirst: mocks.find } } }));
vi.mock("@/lib/server/provider-connection-state", () => ({ getCurrentProviderConnection: mocks.connection }));
vi.mock("@/lib/billing/entitlements", () => ({ getUserEntitlement: mocks.entitlement }));
vi.mock("@/lib/server/production-cleanup", () => ({ assertProductionCleanupInfrastructure: mocks.infrastructure,
  requireProductionCleanupAccess: mocks.access }));
vi.mock("@/lib/server/gmail-scalable-live-workflow", () => ({ getDurableGmailScalableCleanupStatus: mocks.gmail }));
vi.mock("@/lib/server/outlook-cleanup-store", () => ({ createPrismaOutlookCleanupStore: () => ({ get: mocks.outlook }),
  serializeOutlookCleanupJob: (job: unknown) => job }));
vi.mock("@/lib/server/live-scan-store", () => ({ getLiveScan: mocks.report }));
vi.mock("@/lib/server/report-state", () => ({ getActiveReportStateOrRedirect: mocks.redirectReport }));
vi.mock("@/lib/server/gmail-cleanup", () => ({ publicCleanupGroupsFromReport: () => [], availableCleanupCounts: () => [5, 10, 25, 100] }));
vi.mock("@/lib/server/gmail-scalable-cleanup-runner", () => ({ getCurrentGmailScalableCleanup: vi.fn() }));
vi.mock("@/lib/server/outlook-cleanup", () => ({ getCurrentOutlookCleanup: vi.fn() }));
vi.mock("@/lib/config", () => ({ runtimeConfig: {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), redirect: vi.fn() }));

import { getProductionCleanupUiState } from "@/lib/server/production-cleanup-ui";
import { GET } from "../app/api/app/cleanup/availability/route";
import CleanupPage from "../app/app/cleanup/page";

const job = { id: "job", provider: "microsoft", status: "uncertain", requested: 500, approved: 500,
  excludedBySafety: 0, movedVerified: 20, restoredVerified: 0, failed: 0, uncertain: 5, checked: 25,
  groupIndices: [0], undoAvailable: true, undoMode: "recovery", undoStatus: "available", recoverableCount: 20,
  createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 600_000,
  totalBatches: 25, batchesCompleted: 1, undoTotalBatches: 1, undoBatchesCompleted: 0,
  payload: { messageId: "mailbox-secret" }, graphRequests: 99 };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("NODE_ENV", "production");
  mocks.connection.mockResolvedValue({ mode: "connected", userId: "owner", provider: "microsoft", providerConnectionId: "connection" });
  mocks.find.mockResolvedValue(null); mocks.entitlement.mockResolvedValue({ paidAccess: true, state: "active" });
  mocks.infrastructure.mockImplementation(() => {}); mocks.access.mockResolvedValue(undefined);
  mocks.outlook.mockResolvedValue(job); mocks.report.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External requests prohibited"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("server-resolved cleanup presentation", () => {
  it.each(["gmail", "microsoft"])("uses scoped ownership and backend forward authorization for %s", async (provider) => {
    mocks.connection.mockResolvedValue({ mode: "connected", userId: "owner", provider, providerConnectionId: "connection" });
    expect(await getProductionCleanupUiState()).toMatchObject({ access: "available", provider, hasJob: false });
    expect(mocks.find.mock.calls[0][0].where).toMatchObject({ userId: "owner", expiresAt: { gt: expect.any(Date) },
      job: { status: { not: "cancelled" }, scan: { provider, providerConnectionId: "connection" } } });
    expect(mocks.access).toHaveBeenCalledWith({ userId: "owner", provider, providerConnectionId: "connection", access: "forward" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["free", "inactive", "active"])("maps %s from durable credit state", async (state) => {
    mocks.entitlement.mockResolvedValue({ state, paidAccess: state === "active" });
    expect((await getProductionCleanupUiState()).access).toBe(state === "free" ? "upgrade" : state === "active" ? "available" : state);
    if (state !== "active") expect(mocks.access).not.toHaveBeenCalled();
  });
  it("retains owned recovery when forward flags or billing verification fail", async () => {
    mocks.find.mockResolvedValue({ jobId: "job", job: { scanId: "scan" } });
    mocks.infrastructure.mockImplementation((_provider, access) => { if (access === "forward") throw new Error("disabled"); });
    const state = await getProductionCleanupUiState(true);
    expect(state).toMatchObject({ access: "unavailable", hasJob: true, outlookJob: { id: "job", uncertain: 5, undoMode: "recovery" } });
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith({ userId: "owner", provider: "microsoft", providerConnectionId: "connection", access: "recovery", jobId: "job" });
    expect(mocks.entitlement).not.toHaveBeenCalled();
    expect(JSON.stringify(state.outlookJob)).not.toMatch(/mailbox-secret|graphRequests|payload/);
    mocks.infrastructure.mockImplementation(() => {});
    mocks.entitlement.mockRejectedValue(new Error("Stripe unavailable"));
    expect(await getProductionCleanupUiState(true)).toMatchObject({ access: "unavailable", hasJob: true, outlookJob: { id: "job" } });
  });
  it("renders recovery even when the Inbox Report is expired or cannot be read", async () => {
    mocks.find.mockResolvedValue({ jobId: "job", job: { scanId: "scan" } });
    mocks.infrastructure.mockImplementation((_provider, access) => { if (access === "forward") throw new Error("disabled"); });
    for (const failed of [false, true]) {
      if (failed) mocks.report.mockRejectedValue(new Error("report unavailable"));
      const html = renderToStaticMarkup(await CleanupPage());
      expect(html).toContain("Recovery Undo until");
      expect(html).toContain("Some messages remain unresolved");
      expect(html).not.toContain("Move up to");
      expect(html).not.toMatch(/mailbox-secret|graphRequests|payload|Workflow|Prisma|diagnostic/);
    }
    expect(mocks.redirectReport).not.toHaveBeenCalled();
  });
  it("does not expose a job after recovery authorization fails", async () => {
    mocks.find.mockResolvedValue({ jobId: "job", job: { scanId: "scan" } });
    mocks.access.mockRejectedValue(new Error("expired or not owned"));
    expect(await getProductionCleanupUiState(true)).toEqual({ access: "unavailable", hasJob: false });
    expect(mocks.outlook).not.toHaveBeenCalled();
  });
  it("fails closed for disconnected, misconfigured and database-error states", async () => {
    mocks.connection.mockResolvedValueOnce({ mode: "none" });
    expect((await getProductionCleanupUiState()).access).toBe("reconnect");
    mocks.infrastructure.mockImplementationOnce(() => { throw new Error("missing encryption"); });
    expect(await getProductionCleanupUiState()).toEqual({ access: "unavailable", hasJob: false });
    mocks.find.mockRejectedValueOnce(new Error("private database URL"));
    expect(await getProductionCleanupUiState()).toEqual({ access: "unavailable", hasJob: false });
  });
  it("availability response contains only safe access flags and is never cached", async () => {
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ access: "available", provider: "microsoft", hasJob: false });
    vi.stubEnv("NODE_ENV", "development");
    expect((await GET()).status).toBe(404);
  });
  it("renders the appropriate disabled or Upgrade state on direct page entry", async () => {
    mocks.entitlement.mockResolvedValue({ paidAccess: false, state: "free" });
    const html = renderToStaticMarkup(createElement("div", null, await CleanupPage()));
    expect(html).toContain(">Buy credits</a>");
    expect(html).not.toContain("Check 500 messages");
    expect(mocks.redirectReport).not.toHaveBeenCalled();
  });
});
