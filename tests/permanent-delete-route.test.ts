import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), gate: vi.fn(), accept: vi.fn(), dispatch: vi.fn(), count: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/server/db", () => ({ prisma: { cleanupJob: { count: mocks.count } } }));
vi.mock("@/lib/server/production-cleanup", () => ({ requireProductionCleanupAccess: mocks.access, assertProductionCleanupInfrastructure: mocks.gate }));
vi.mock("@/lib/server/cleanup-job-store", () => ({ PrismaCleanupJobStore: class { get = mocks.get; } }));
vi.mock("@/lib/server/permanent-delete", () => ({ acceptPermanentDelete: mocks.accept, deletionProvider: () => "microsoft", deletionView: () => ({ status: "running", requested: 5, verifiedDeleted: 0 }) }));
vi.mock("workflow/api", () => ({ start: mocks.dispatch }));
import { POST } from "../app/api/app/cleanup/[provider]/permanent-delete/route";
const origin = "https://example.test";
const job = { userId: "owner", permanentDeletion: { status: "running" } };
const call = (body: object, from = origin, provider = "microsoft") => POST(new Request(`${origin}/api/app/cleanup/${provider}/permanent-delete`, {
  method: "POST", headers: { origin: from }, body: JSON.stringify(body)
}), { params: Promise.resolve({ provider }) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
  mocks.session.mockResolvedValue({ userId: "owner", providerConnectionId: "connection" }); mocks.count.mockResolvedValue(1); mocks.get.mockResolvedValue(job); mocks.accept.mockResolvedValue(job); });
afterEach(() => vi.unstubAllEnvs());
it("requires both confirmations and rejects mailbox identifiers", async () => {
  for (const extra of [{}, { confirmed: true }, { acknowledged: true }, { confirmed: true, acknowledged: true, messageIds: ["injected"] }]) {
    expect((await call({ jobId: "job", action: "delete", ...extra })).status).toBe(400);
  }
  expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
});
it("requires session, origin and owning provider job", async () => {
  expect((await call({ jobId: "job", action: "status" }, "https://attacker.test")).status).toBe(403);
  expect((await call({ jobId: "job", action: "status" }, origin, "gmail")).status).toBe(410);
  mocks.session.mockResolvedValue(null);
  expect((await call({ jobId: "job", action: "status" })).status).toBe(401);
});
it("dispatches existing exact jobs without a second charge and can redispatch after scheduling failure", async () => {
  mocks.dispatch.mockRejectedValueOnce(new Error("private"));
  const body = { jobId: "job", action: "delete", confirmed: true, acknowledged: true };
  const failed = await call(body); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private");
  expect((await call(body)).status).toBe(200);
  expect(mocks.accept).toHaveBeenCalledWith("owner", "job", "microsoft", expect.anything());
  expect(mocks.access).toHaveBeenCalledWith(expect.objectContaining({ access: "recovery", jobId: "job" }));
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
});
it("rollback blocks new deletion but preserves read-only result access", async () => {
  mocks.gate.mockImplementation(() => { throw new Error("off"); });
  expect((await call({ jobId: "job", action: "delete", confirmed: true, acknowledged: true })).status).toBe(503);
  const response = await call({ jobId: "job", action: "status" });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ canDelete: false });
  expect(mocks.accept).not.toHaveBeenCalled();
});
