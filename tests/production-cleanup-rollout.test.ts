import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const mocks = vi.hoisted(() => ({ session: vi.fn(), paid: vi.fn(), connection: vi.fn(), owned: vi.fn(),
  start: vi.fn(), confirm: vi.fn(), undo: vi.fn(), status: vi.fn(), dispatch: vi.fn(),
  runtime: { gmailAvailable: true, microsoftAvailable: true, gmailScalableStoreAdapter: "prisma" } }));
vi.mock("@/lib/config", () => ({ runtimeConfig: mocks.runtime }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/server/db", () => ({ prisma: { providerConnection: { findFirst: mocks.connection }, cleanupJobState: { count: mocks.owned } } }));
vi.mock("@/lib/billing/entitlements", async (original) => ({
  ...await original<typeof import("@/lib/billing/entitlements")>(), requirePaidCleanupEntitlement: mocks.paid
}));
vi.mock("@/lib/server/gmail-scalable-cleanup-runner", () => ({ startGmailScalableCleanup: mocks.start,
  confirmGmailScalableCleanup: mocks.confirm, undoGmailScalableCleanup: mocks.undo, getGmailScalableCleanupStatus: mocks.status }));
vi.mock("@/lib/server/outlook-cleanup", () => ({ startOutlookCleanup: mocks.start, confirmOutlookCleanup: mocks.confirm,
  undoOutlookCleanup: mocks.undo, getOutlookCleanupStatus: mocks.status }));
vi.mock("workflow/api", () => ({ start: mocks.dispatch }));

import { POST } from "../app/api/app/cleanup/[provider]/[action]/route";
import { requireProductionCleanupAccess, resolveProductionCleanup } from "@/lib/server/production-cleanup";
import { createCleanupRequestFence } from "@/lib/server/provider-work-fence";
import { EntitlementDeniedError } from "@/lib/billing/entitlements";
import { startGmailScalableCleanupWorkflow, startGmailScalableUndoWorkflow } from "@/lib/server/gmail-scalable-workflow-start";

const origin = "https://example.test";
const configured = {
  NODE_ENV: "production", NEXT_PUBLIC_APP_URL: origin, DATABASE_URL: "postgresql://localhost/fixture",
  TOKEN_ENCRYPTION_KEY: "t".repeat(32), CLEANUP_STATE_ENCRYPTION_KEY: "s".repeat(32), CRON_SECRET: "fixture-cron",
  GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture", GOOGLE_REDIRECT_URI: `${origin}/api/oauth/google/callback`,
  MICROSOFT_CLIENT_ID: "fixture", MICROSOFT_CLIENT_SECRET: "fixture", MICROSOFT_REDIRECT_URI: `${origin}/api/oauth/microsoft/callback`,
  GMAIL_PRODUCTION_ENABLED: "true", MICROSOFT_PRODUCTION_ENABLED: "true", CLEANUP_WORKFLOW_ENABLED: "true",
  GMAIL_PRODUCTION_CLEANUP_ENABLED: "true", MICROSOFT_PRODUCTION_CLEANUP_ENABLED: "true",
  STRIPE_BILLING_MODE: "test", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_PRICE_10000_CREDITS: "price_small", STRIPE_PRICE_50000_CREDITS: "price_medium", STRIPE_PRICE_100000_CREDITS: "price_large"
};
const connection = { id: "connection", userId: "owner", encryptedAccessToken: "encrypted", encryptedRefreshToken: "encrypted",
  encryptedAccountEmail: "encrypted", disconnectedAt: null, scope: "https://mail.google.com/ Mail.ReadWrite" };
const view = { id: "job", provider: "microsoft", status: "ready", requested: 5, approved: 5, movedVerified: 0,
  restoredVerified: 0, failed: 0, uncertain: 0, undoAvailable: false, undoStatus: "not_available", expiresAt: Date.now() + 60_000,
  graphRequests: 999, timingMs: { move: 88 }, payload: { messageId: "private-message", folderId: "private-folder" },
  error: "private provider response", terminalDiagnostic: "private diagnostic" };

function call(provider = "gmail", action = "start", body: object = {}, from = origin) {
  return POST(new Request(`${origin}/api/app/cleanup/${provider}/${action}`, { method: "POST", headers: { origin: from },
    body: JSON.stringify({ requestedCount: provider === "gmail" ? 250 : 5, groupIndices: [0], jobId: "job", confirmed: true, ...body })
  }), { params: Promise.resolve({ provider, action }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(configured)) vi.stubEnv(key, value);
  Object.assign(mocks.runtime, { gmailAvailable: true, microsoftAvailable: true, gmailScalableStoreAdapter: "prisma" });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Provider requests prohibited"); }));
  mocks.session.mockResolvedValue({ userId: "owner", providerConnectionId: "connection" });
  mocks.paid.mockResolvedValue({ paidAccess: true });
  mocks.connection.mockResolvedValue(connection);
  mocks.owned.mockResolvedValue(1);
  for (const fn of [mocks.start, mocks.confirm, mocks.undo, mocks.status]) fn.mockResolvedValue(view);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("production cleanup rollout authorization", () => {
  it("defaults forward cleanup off independently of provider and Workflow configuration", () => {
    const settings = { ...configured, GMAIL_PRODUCTION_CLEANUP_ENABLED: undefined, MICROSOFT_PRODUCTION_CLEANUP_ENABLED: undefined };
    expect(resolveProductionCleanup(settings)).toEqual({ gmail: { forward: false, recovery: true }, microsoft: { forward: false, recovery: true } });
    expect(resolveProductionCleanup({}).gmail).toEqual({ forward: false, recovery: false });
  });
  it.each(["gmail", "microsoft"])("denies unpaid %s and does not trust body entitlement/ownership", async (provider) => {
    mocks.paid.mockRejectedValue(new EntitlementDeniedError("upgrade"));
    const result = await call(provider, "start", { paidAccess: true, userId: "attacker" });
    expect(result.status).toBe(402);
    expect(await result.json()).toMatchObject({ code: "PAID_ACCESS_REQUIRED", href: "/app/account" });
    expect(mocks.paid).toHaveBeenCalledExactlyOnceWith("owner", undefined);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it.each(["gmail", "microsoft"])("keeps a paid %s user blocked while its cleanup gate is off", async (provider) => {
    vi.stubEnv(provider === "gmail" ? "GMAIL_PRODUCTION_CLEANUP_ENABLED" : "MICROSOFT_PRODUCTION_CLEANUP_ENABLED", "false");
    expect((await call(provider)).status).toBe(503);
    expect((await call(provider, "confirm")).status).toBe(503);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("allows each provider only with all gates and uses the existing services", async () => {
    for (const provider of ["gmail", "microsoft"]) {
      expect((await call(provider)).status).toBe(200);
      expect((await call(provider, "confirm")).status).toBe(200);
    }
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.connection).toHaveBeenCalledWith({ where: { id: "connection", userId: "owner", provider: "gmail", disconnectedAt: null } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not enable one provider through the other provider's flag", async () => {
    vi.stubEnv("MICROSOFT_PRODUCTION_CLEANUP_ENABLED", "false");
    expect((await call("gmail")).status).toBe(200);
    expect((await call("microsoft")).status).toBe(503);
    vi.stubEnv("MICROSOFT_PRODUCTION_CLEANUP_ENABLED", "true");
    vi.stubEnv("GMAIL_PRODUCTION_CLEANUP_ENABLED", "false");
    expect((await call("gmail")).status).toBe(503);
    expect((await call("microsoft")).status).toBe(200);
  });
  it.each(["DATABASE_URL", "TOKEN_ENCRYPTION_KEY", "CLEANUP_STATE_ENCRYPTION_KEY", "CRON_SECRET", "CLEANUP_WORKFLOW_ENABLED"])(
    "fails closed without %s for both forward and recovery work", async (key) => {
      vi.stubEnv(key, "");
      for (const provider of ["gmail", "microsoft"]) {
        expect((await call(provider)).status).toBe(503);
        expect((await call(provider, "undo")).status).toBe(503);
      }
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.undo).not.toHaveBeenCalled();
    }
  );
  it("requires the durable adapter, provider availability, OAuth configuration and a valid connection", async () => {
    mocks.runtime.gmailScalableStoreAdapter = "memory";
    expect((await call()).status).toBe(503);
    mocks.runtime.gmailScalableStoreAdapter = "prisma";
    mocks.runtime.gmailAvailable = false;
    expect((await call()).status).toBe(503);
    mocks.runtime.gmailAvailable = true;
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect((await call()).status).toBe(503);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture");
    for (const value of [null, { ...connection, scope: "openid" }, { ...connection, encryptedRefreshToken: null }]) {
      mocks.connection.mockResolvedValue(value);
      expect((await call()).status).toBe(401);
    }
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("fails closed on infrastructure/entitlement exceptions without exposing raw errors", async () => {
    mocks.paid.mockRejectedValueOnce(new Error("secret Stripe response"));
    expect(await (await call()).text()).not.toContain("secret");
    mocks.connection.mockRejectedValueOnce(new Error("secret database URL"));
    const result = await call();
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("secret");
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("requires origin/session and explicit confirmation and rejects diagnostic/unsupported actions", async () => {
    expect((await call("gmail", "start", {}, "https://attacker.test")).status).toBe(403);
    mocks.session.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    expect((await call("gmail", "confirm", { confirmed: false })).status).toBe(400);
    expect((await call("gmail", "undo", { confirmed: false })).status).toBe(400);
    expect((await call("gmail", "diagnostic")).status).toBe(404);
    expect((await call("gmail", "start", { requestedCount: 1000 })).status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("never serializes diagnostics, IDs from provider payloads, or raw errors", async () => {
    const response = await call("microsoft", "status");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const content = await response.text();
    expect(content).toContain('"id":"job"');
    expect(content).not.toMatch(/private|graphRequests|timingMs|payload|terminalDiagnostic/);
  });
});

describe("rollback and recovery", () => {
  it("can dispatch the existing Gmail Undo Workflow while forward scheduling is disabled", async () => {
    vi.stubEnv("GMAIL_PRODUCTION_CLEANUP_ENABLED", "false");
    await expect(startGmailScalableCleanupWorkflow("job")).rejects.toMatchObject({ code: "CLEANUP_UNAVAILABLE" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await startGmailScalableUndoWorkflow("job");
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(expect.any(Function), ["job"]);
    expect(mocks.paid).not.toHaveBeenCalled();
  });
  it.each(["gmail", "microsoft"])("preserves %s status and Undo despite disabled forward cleanup, expired billing and missing Stripe config", async (provider) => {
    vi.stubEnv("GMAIL_PRODUCTION_CLEANUP_ENABLED", "false");
    vi.stubEnv("MICROSOFT_PRODUCTION_CLEANUP_ENABLED", "false");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    mocks.paid.mockRejectedValue(new EntitlementDeniedError("manage"));
    expect((await call(provider, "status")).status).toBe(200);
    expect((await call(provider, "undo")).status).toBe(200);
    expect(mocks.paid).not.toHaveBeenCalled();
    expect(mocks.undo).toHaveBeenCalledExactlyOnceWith("job");
    expect(mocks.owned).toHaveBeenCalledWith({ where: { jobId: "job", userId: "owner", expiresAt: { gt: expect.any(Date) },
      job: { status: { not: "cancelled" }, scan: { userId: "owner", provider, providerConnectionId: "connection" } } } });
  });
  it("requires an exact existing owned/unexpired job and never accepts client recovery exemptions", async () => {
    await expect(requireProductionCleanupAccess({ userId: "owner", provider: "gmail", access: "recovery" })).rejects.toMatchObject({ status: 400 });
    mocks.owned.mockResolvedValue(0);
    expect((await call("gmail", "undo")).status).toBe(410);
    expect(mocks.undo).not.toHaveBeenCalled();
    vi.stubEnv("GMAIL_PRODUCTION_CLEANUP_ENABLED", "false");
    expect((await call("gmail", "start", { access: "recovery" })).status).toBe(503);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("permits recovery worker fences but blocks forward fences after rollback, retaining lease/generation binding", async () => {
    vi.stubEnv("GMAIL_PRODUCTION_CLEANUP_ENABLED", "false");
    const owner = { id: "connection", userId: "owner", provider: "gmail" as const, sessionGeneration: "generation" };
    await expect(createCleanupRequestFence(owner, "job", "worker", 7)()).rejects.toMatchObject({ name: "AbortError" });
    await createCleanupRequestFence(owner, "job", "worker", 7, "recovery")();
    expect(mocks.owned.mock.calls.at(-1)?.[0].where).toMatchObject({ lockOwner: "worker", version: 7,
      lockExpiresAt: { gt: expect.any(Date) }, job: { scan: { providerConnection: { disconnectedAt: null, sessionGeneration: "generation" } } } });
    mocks.owned.mockResolvedValueOnce(0);
    await expect(createCleanupRequestFence(owner, "job", "stale-worker", 6, "recovery")()).rejects.toMatchObject({ name: "AbortError" });
  });
  it("leaves development access unchanged and every dev API blocked in production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await call()).status).toBe(404);
    await requireProductionCleanupAccess({ userId: "owner", provider: "gmail", access: "forward" });
    expect(mocks.paid).not.toHaveBeenCalled();
    expect(mocks.connection).not.toHaveBeenCalled();
    for (const name of readdirSync("app/api/dev", { recursive: true }).filter((path) => String(path).endsWith("route.ts"))) {
      expect(readFileSync(`app/api/dev/${name}`, "utf8")).toMatch(/if \(process.env.NODE_ENV === "production"\).*status: 404/);
    }
  });
});
