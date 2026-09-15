import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { renderToStaticMarkup } from "react-dom/server";
import { BillingPanel } from "@/components/product/BillingPanel";
import { StripeBillingService } from "@/lib/billing/service";
import { POST as webhook } from "../app/api/webhooks/stripe/route";
import { POST as checkout } from "../app/api/checkout/route";
import { POST as portal } from "../app/api/billing/portal/route";
import { requirePaidCleanupEntitlement } from "@/lib/billing/entitlements";
import { POST as reconcile } from "../app/api/billing/reconcile/route";

const mocks = vi.hoisted(() => ({ session: vi.fn(), account: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/server/db", () => ({ prisma: { billingAccount: { findUnique: mocks.account } } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const origin = "https://example.test";
const secret = "whsec_fixture";
const sdk = new Stripe("sk_test_fixture");
const payload = JSON.stringify({ id: "evt_fixture", type: "customer.subscription.updated", livemode: false,
  data: { object: { customer: "cus_fixture" } } });

function signedRequest(body = payload, signature?: string) {
  return new Request(`${origin}/api/webhooks/stripe`, { method: "POST", body,
    headers: { "stripe-signature": signature ?? sdk.webhooks.generateTestHeaderString({ payload, secret }) } });
}
function actionRequest(path: string, from = origin) {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin: from, accept: "application/json" },
    body: JSON.stringify({ userId: "attacker", customer: "cus_attacker", priceId: "price_attacker", return_url: "https://attacker.test" }) });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("STRIPE_BILLING_ENABLED", "true");
  vi.stubEnv("STRIPE_BILLING_MODE", "test");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
  vi.stubEnv("STRIPE_SUBSCRIPTION_PRICE_ID", "price_fixture");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/fixture");
  mocks.session.mockResolvedValue({ userId: "user-1" });
  mocks.account.mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("Stripe webhook HTTP boundary", () => {
  it("verifies the original raw payload before processing", async () => {
    const process = vi.spyOn(StripeBillingService.prototype, "webhook").mockResolvedValue({ result: "processed" });
    const response = await webhook(signedRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(process).toHaveBeenCalledExactlyOnceWith(JSON.parse(payload));
  });
  it("rejects tampering, incorrect secrets, stale signatures and missing signatures before processing", async () => {
    const process = vi.spyOn(StripeBillingService.prototype, "webhook");
    const requests = [signedRequest(payload + " "),
      signedRequest(payload, sdk.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong" })),
      signedRequest(payload, sdk.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) - 1000 })),
      new Request(`${origin}/api/webhooks/stripe`, { method: "POST", body: payload })];
    for (const request of requests) {
      const response = await webhook(request);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toMatch(/cus_fixture|evt_fixture|whsec_|customer.subscription/);
    }
    expect(process).not.toHaveBeenCalled();
  });
  it("limits raw payload size and sanitizes retriable processing errors", async () => {
    const process = vi.spyOn(StripeBillingService.prototype, "webhook").mockRejectedValue(new Error("secret provider response cus_private"));
    expect((await webhook(signedRequest("x".repeat(1_000_001)))).status).toBe(413);
    expect(process).not.toHaveBeenCalled();
    const response = await webhook(signedRequest());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/secret|cus_private|provider/);
  });
});

describe("billing session and entitlement boundary", () => {
  it.each([checkout, portal, reconcile])("requires same-origin authenticated requests", async (handler) => {
    expect((await handler(actionRequest("/api/checkout", "https://attacker.test"))).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue(null);
    expect((await handler(actionRequest("/api/checkout"))).status).toBe(401);
  });
  it("uses the validated session, never client prices, ownership or redirect parameters", async () => {
    const create = vi.spyOn(StripeBillingService.prototype, "checkout").mockResolvedValue("https://checkout.stripe.com/c/pay/fixture");
    const manage = vi.spyOn(StripeBillingService.prototype, "portal").mockResolvedValue("https://billing.stripe.com/p/session/fixture");
    expect((await checkout(actionRequest("/api/checkout"))).status).toBe(200);
    expect((await portal(actionRequest("/api/billing/portal"))).status).toBe(200);
    expect(create).toHaveBeenCalledExactlyOnceWith("user-1");
    expect(manage).toHaveBeenCalledExactlyOnceWith("user-1");
  });
  it("fails closed with missing configuration, missing entitlement, expiry or database failure", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect((await checkout(actionRequest("/api/checkout"))).status).toBe(503);
    await expect(requirePaidCleanupEntitlement("user-1")).rejects.toThrow("Paid access is inactive");
    expect(mocks.account).not.toHaveBeenCalled();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture");
    await expect(requirePaidCleanupEntitlement("user-1")).rejects.toThrow("active paid subscription");
    const row = { stripeCustomerId: "cus_fixture", syncedAt: new Date(), stripeSubscriptionId: "sub_fixture", stripePriceId: "price_fixture", livemode: false,
      subscriptionStatus: "active", latestInvoicePaid: true, currentPeriodEnd: new Date(Date.now() + 60_000) };
    mocks.account.mockResolvedValue(row);
    expect((await requirePaidCleanupEntitlement("user-1")).paidAccess).toBe(true);
    expect(mocks.account).toHaveBeenLastCalledWith({ where: { userId: "user-1" } });
    mocks.account.mockResolvedValue({ ...row, currentPeriodEnd: new Date(0) });
    await expect(requirePaidCleanupEntitlement("user-1")).rejects.toThrow("Paid access is inactive");
    mocks.account.mockRejectedValue(new Error("database unavailable"));
    await expect(requirePaidCleanupEntitlement("user-1")).rejects.toThrow("could not be verified");
  });
});

describe("minimal account billing UI", () => {
  it("shows free subscription action without exposing server configuration or enabling cleanup", async () => {
    const html = renderToStaticMarkup(await BillingPanel());
    expect(html).toContain("Upgrade");
    expect(html).toContain("Free / no paid access");
    expect(html).toContain("paid access where cleanup is available for your inbox");
    expect(html).not.toMatch(/sk_test_|whsec_|price_fixture|cus_fixture|user-1/);
  });
  it("shows subscribed status and Portal only, retaining cancellation-period wording", async () => {
    mocks.account.mockResolvedValue({ stripeCustomerId: "cus_fixture", stripeSubscriptionId: "sub_fixture",
      stripePriceId: "price_fixture", livemode: false, subscriptionStatus: "active", latestInvoicePaid: true,
      cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() + 3600_000), syncedAt: new Date() });
    const html = renderToStaticMarkup(await BillingPanel());
    expect(html).toContain("Cancelled / paid access until period end");
    expect(html).toContain("Manage billing");
    expect(html).not.toContain("Upgrade");
    expect(html).toContain("Refresh billing status");
    expect(html).not.toMatch(/cus_fixture|sub_fixture|price_fixture/);
  });
  it("hides purchase actions when disabled, signed out, or unavailable", async () => {
    vi.stubEnv("STRIPE_BILLING_ENABLED", "false");
    expect(renderToStaticMarkup(await BillingPanel())).not.toContain("Upgrade");
    mocks.session.mockResolvedValue(null);
    expect(renderToStaticMarkup(await BillingPanel())).toContain("Sign in to manage billing");
    mocks.session.mockResolvedValue({ userId: "user-1" });
    mocks.account.mockRejectedValue(new Error("private database error"));
    const html = renderToStaticMarkup(await BillingPanel());
    expect(html).toContain("Billing is temporarily unavailable");
    expect(html).not.toContain("private database error");
  });
});

describe("billing recovery and monitoring boundary", () => {
  it("refreshes only the signed-in account and returns only the safe entitlement projection", async () => {
    const recover = vi.spyOn(StripeBillingService.prototype, "reconcile").mockResolvedValue(null);
    const response = await reconcile(actionRequest("/api/billing/reconcile"));
    expect(response.status).toBe(200);
    expect(recover).toHaveBeenCalledExactlyOnceWith("user-1", true);
    expect(await response.json()).toEqual({ entitlement: { state: "free", paidAccess: false, periodEnd: null } });
  });
  it("keeps Portal accessible when reconciliation fails and does not show stale paid access", async () => {
    mocks.account.mockResolvedValue({ stripeCustomerId: "cus_fixture", stripeSubscriptionId: "sub_fixture",
      stripePriceId: "price_fixture", livemode: false, subscriptionStatus: "active", latestInvoicePaid: true,
      currentPeriodEnd: new Date(Date.now() + 3600_000), syncedAt: new Date(0) });
    vi.spyOn(StripeBillingService.prototype, "reconcile").mockRejectedValue(new Error("private response"));
    const html = renderToStaticMarkup(await BillingPanel());
    expect(html).toContain("Billing access could not be verified");
    expect(html).toContain("Manage billing");
    expect(html).toContain("Refresh billing status");
    expect(html).not.toMatch(/Active paid subscription|private response|cus_fixture|sub_fixture/);
  });
  it("emits only fixed operational event names, never exceptions or payment identifiers", async () => {
    vi.spyOn(StripeBillingService.prototype, "checkout").mockRejectedValue(new Error("sk_live_secret cus_private card payment mailbox"));
    await checkout(actionRequest("/api/checkout"));
    await webhook(signedRequest(payload + " "));
    vi.spyOn(StripeBillingService.prototype, "webhook").mockRejectedValue(new Error("private response"));
    await webhook(signedRequest());
    await expect(requirePaidCleanupEntitlement("user-1")).rejects.toThrow();
    const entries = vi.mocked(console.warn).mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(entries.map((entry) => entry.event)).toEqual(expect.arrayContaining([
      "checkout_failed", "webhook_signature_failed", "webhook_processing_failed", "entitlement_denied"
    ]));
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(["component", "event"]);
    expect(JSON.stringify(entries)).not.toMatch(/sk_live_|cus_|private|mailbox|user-1|card/);
  });
});
