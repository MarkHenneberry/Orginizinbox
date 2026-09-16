import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productionCleanupBoundary } from "@/lib/billing/cleanup-boundary";
import { POST as gmailStart } from "../app/api/dev/gmail-scalable-cleanup/start/route";
import { POST as gmailConfirm } from "../app/api/dev/gmail-scalable-cleanup/confirm/route";
import { POST as gmailLegacyStart } from "../app/api/dev/gmail-cleanup/resolve/route";
import { POST as gmailLegacyConfirm } from "../app/api/dev/gmail-cleanup/confirm/route";
import { POST as outlookStart } from "../app/api/dev/outlook-cleanup/start/route";
import { POST as outlookConfirm } from "../app/api/dev/outlook-cleanup/confirm/route";

const mocks = vi.hoisted(() => ({ session: vi.fn(), account: vi.fn(), start: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/server/db", () => ({ prisma: { billingAccount: { findUnique: mocks.account }, user: { findUniqueOrThrow: async () => ({ creditOwnerId: null }) },
  creditJobAccounting: { findMany: async () => [] } } }));
vi.mock("@/lib/server/gmail-scalable-cleanup-runner", () => ({ startGmailScalableCleanup: mocks.start, confirmGmailScalableCleanup: mocks.confirm }));
vi.mock("@/lib/server/gmail-scalable-cleanup-route", () => ({ scalableCleanupResponse: () => new Response(null, { status: 500 }) }));
vi.mock("@/lib/server/outlook-cleanup", () => ({ startOutlookCleanup: mocks.start, confirmOutlookCleanup: mocks.confirm }));
vi.mock("@/lib/server/outlook-cleanup-route", () => ({ outlookCleanupResponse: () => new Response(null, { status: 500 }) }));
vi.mock("@/lib/server/gmail-cleanup", () => ({ createGmailCleanupPreview: mocks.start, confirmGmailCleanup: mocks.confirm,
  parseCleanupCount: (x: unknown) => x, parseCleanupGroupIndices: (x: unknown) => x, GmailCleanupError: class extends Error {} }));
const origin = "https://example.test";
const handlers = [gmailStart, gmailConfirm, gmailLegacyStart, gmailLegacyConfirm, outlookStart, outlookConfirm];
const request = (from = origin) => new Request(`${origin}/api/dev/cleanup`, {
  method: "POST", headers: { origin: from }, body: JSON.stringify({ userId: "attacker", paidAccess: true,
    jobId: "fixture-job", confirmation: "MOVE_TO_TRASH", confirmed: true, groupIndices: [0], requestedCount: 5 })
});
const active = () => ({ stripeCustomerId: "cus_fixture", creditBalance: 10000, livemode: false, syncedAt: new Date() });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const env = { NODE_ENV: "production", STRIPE_BILLING_ENABLED: "false", STRIPE_BILLING_MODE: "test", STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture", STRIPE_PRICE_10000_CREDITS: "price_small", STRIPE_PRICE_50000_CREDITS: "price_medium", STRIPE_PRICE_100000_CREDITS: "price_large", NEXT_PUBLIC_APP_URL: origin,
    DATABASE_URL: "postgresql://localhost/fixture", TOKEN_ENCRYPTION_KEY: "t".repeat(32) };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  mocks.session.mockResolvedValue({ userId: "owner" });
  mocks.account.mockResolvedValue(active());
  mocks.start.mockResolvedValue({ status: "preview" });
  mocks.confirm.mockResolvedValue({ status: "accepted" });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("provider-neutral production cleanup billing boundary", () => {
  it("remains unavailable even for paid users and cannot be enabled by a submitted flag", async () => {
    vi.stubEnv("PRODUCTION_CLEANUP_ENABLED", "true");
    vi.stubEnv("GMAIL_CLEANUP_ENABLED", "true");
    vi.stubEnv("OUTLOOK_CLEANUP_DEV_ENABLED", "true");
    for (const handler of handlers) {
      const response = await handler(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "CLEANUP_UNAVAILABLE" });
    }
    expect(mocks.account).toHaveBeenLastCalledWith({ where: { userId: "owner" } });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it.each(["free", "empty", "refunded", "wrong-mode"])("rejects %s at every Gmail and Outlook entry point", async (state) => {
    mocks.account.mockResolvedValue(state === "free" ? null : { ...active(),
      creditBalance: state === "refunded" ? -500 : state === "empty" ? 0 : 10000,
      livemode: state === "wrong-mode" });
    for (const handler of handlers) {
      const response = await handler(request());
      expect(response.status).toBe(state === "wrong-mode" ? 409 : 402);
      expect(await response.json()).toMatchObject(state === "wrong-mode" ? { code: "BILLING_UNAVAILABLE", href: "/app/account" }
        : { code: "PAID_ACCESS_REQUIRED", href: "/app/account", action: ["free", "empty"].includes(state) ? "upgrade" : "manage" });
    }
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("does not expire credits with an old subscription period", async () => {
    mocks.account.mockResolvedValue({ ...active(), currentPeriodEnd: new Date(0) });
    expect((await productionCleanupBoundary(request()))?.status).toBe(503);
    mocks.account.mockResolvedValue({ ...active(), creditBalance: 0 });
    expect((await productionCleanupBoundary(request()))?.status).toBe(402);
  });
  it("rejects forged origin, unauthenticated calls and unavailable verification", async () => {
    expect((await productionCleanupBoundary(request("https://attacker.test")))?.status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue(null);
    expect((await productionCleanupBoundary(request()))?.status).toBe(401);
    mocks.session.mockResolvedValue({ userId: "owner" });
    mocks.account.mockRejectedValue(new Error("database secret"));
    const response = await productionCleanupBoundary(request());
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain("database secret");
  });
  it("does not touch sessions, billing or Stripe for development cleanup", async () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const handler of handlers) expect((await handler(request())).status).toBeLessThan(300);
    expect(mocks.start).toHaveBeenCalledTimes(3);
    expect(mocks.confirm).toHaveBeenCalledTimes(3);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.account).not.toHaveBeenCalled();
  });
});
