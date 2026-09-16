import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { renderToStaticMarkup } from "react-dom/server";
import { BillingPanel } from "@/components/product/BillingPanel";
import { StripeBillingService } from "@/lib/billing/service";
import { POST as webhook } from "../app/api/webhooks/stripe/route";
import { POST as checkout } from "../app/api/checkout/route";
import { POST as portal } from "../app/api/billing/portal/route";
import { POST as reconcile } from "../app/api/billing/reconcile/route";
import { requirePaidCleanupEntitlement } from "@/lib/billing/entitlements";
import { environment } from "./fixtures/credit-billing";

const mocks = vi.hoisted(() => ({ session: vi.fn(), account: vi.fn(), jobs: vi.fn(), job: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/server/db", () => ({ prisma: { billingAccount: { findUnique: mocks.account },
  user: { findUniqueOrThrow: mocks.user, count: async () => 1 }, creditJobAccounting: { findMany: mocks.jobs, findUnique: mocks.job } } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const origin = environment.NEXT_PUBLIC_APP_URL;
const sdk = new Stripe("sk_test_fixture");
const payload = JSON.stringify({ id: "evt_fixture", type: "checkout.session.completed", livemode: false, data: { object: { id: "cs_fixture" } } });
function signedRequest(body = payload, signature?: string) {
  return new Request(`${origin}/api/webhooks/stripe`, { method: "POST", body,
    headers: { "stripe-signature": signature ?? sdk.webhooks.generateTestHeaderString({ payload, secret: environment.STRIPE_WEBHOOK_SECRET }) } });
}
const actionRequest = (from = origin, pack = "small") => new Request(`${origin}/api/checkout`, {
  method: "POST", headers: { origin: from, accept: "application/json" },
  body: JSON.stringify({ pack, userId: "attacker", customer: "cus_attacker", priceId: "price_attacker", amount: 1, return_url: "https://attacker.test" })
});
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  mocks.session.mockResolvedValue({ userId: "linked-inbox" });
  mocks.user.mockResolvedValue({ creditOwnerId: "owner" });
  mocks.account.mockResolvedValue(null); mocks.jobs.mockResolvedValue([]);
  mocks.job.mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("signed webhook boundary", () => {
  it("validates the original raw payload before processing", async () => {
    const process = vi.spyOn(StripeBillingService.prototype, "webhook").mockResolvedValue({ result: "processed" });
    const response = await webhook(signedRequest());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(process).toHaveBeenCalledExactlyOnceWith(JSON.parse(payload));
  });
  it("rejects tampering, bad/stale/missing signatures and oversized payloads", async () => {
    const process = vi.spyOn(StripeBillingService.prototype, "webhook");
    for (const request of [signedRequest(payload + " "), signedRequest(payload, "invalid"),
      signedRequest(payload, sdk.webhooks.generateTestHeaderString({ payload, secret: environment.STRIPE_WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) - 1000 })),
      new Request(`${origin}/api/webhooks/stripe`, { method: "POST", body: payload })]) {
      expect((await webhook(request)).status).toBe(400);
    }
    expect((await webhook(signedRequest("x".repeat(1_000_001)))).status).toBe(413);
    expect(process).not.toHaveBeenCalled();
  });
  it("sanitizes failures and operational logs", async () => {
    vi.spyOn(StripeBillingService.prototype, "webhook").mockRejectedValue(new Error("sk_live_private cus_private card mailbox"));
    const response = await webhook(signedRequest());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/sk_live|cus_|card|mailbox/);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/sk_live|cus_|card|mailbox/);
  });
});

describe("account-level checkout and UI", () => {
  it.each([checkout, reconcile])("requires same-origin authentication", async (handler) => {
    expect((await handler(actionRequest("https://attacker.test"))).status).toBe(403);
    mocks.session.mockResolvedValue(null);
    expect((await handler(actionRequest())).status).toBe(401);
  });
  it("uses the shared account and allowlisted pack, not submitted price/customer/amount", async () => {
    const create = vi.spyOn(StripeBillingService.prototype, "checkout").mockResolvedValue("https://checkout.stripe.com/c/pay/fixture");
    expect((await checkout(actionRequest())).status).toBe(200);
    expect(create).toHaveBeenCalledExactlyOnceWith("owner", "small");
    expect((await checkout(actionRequest(origin, "price_attacker"))).status).toBe(400);
    expect((await portal(actionRequest())).status).toBe(404);
  });
  it("returns only aggregate balance fields after explicit reconciliation", async () => {
    const recover = vi.spyOn(StripeBillingService.prototype, "reconcile").mockResolvedValue(null);
    const response = await reconcile(actionRequest());
    expect(recover).toHaveBeenCalledExactlyOnceWith("owner", true);
    expect(await response.json()).toEqual({ entitlement: { state: "free", paidAccess: false, periodEnd: null, balance: 0, reserved: 0, available: 0 } });
  });
  it("requires credits and rejects missing config or mode mismatches", async () => {
    await expect(requirePaidCleanupEntitlement("linked-inbox")).rejects.toThrow("Available cleanup credits");
    mocks.account.mockResolvedValue({ livemode: false, creditBalance: 10000 });
    expect((await requirePaidCleanupEntitlement("linked-inbox")).paidAccess).toBe(true);
    mocks.jobs.mockResolvedValue([{ requested: 10000, moved: 0 }]);
    await expect(requirePaidCleanupEntitlement("linked-inbox")).rejects.toThrow();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect((await checkout(actionRequest())).status).toBe(503);
  });
  it("lets an already-reserved job finish with no spare credits, without authorizing a new or unrelated job", async () => {
    mocks.account.mockResolvedValue({ livemode: false, creditBalance: 500 });
    mocks.jobs.mockResolvedValue([{ requested: 500, moved: 0 }]);
    mocks.job.mockResolvedValue({ userId: "owner", activeStateJobId: "job-1" });
    await expect(requirePaidCleanupEntitlement("linked-inbox", "job-1")).resolves.toMatchObject({ available: 0 });
    await expect(requirePaidCleanupEntitlement("linked-inbox")).rejects.toThrow();
    await expect(requirePaidCleanupEntitlement("linked-inbox", "job-other")).rejects.toThrow();
    mocks.account.mockResolvedValue({ livemode: false, creditBalance: 0 }); mocks.jobs.mockResolvedValue([]);
    await expect(requirePaidCleanupEntitlement("linked-inbox", "job-1")).resolves.toMatchObject({ balance: 0 });
    mocks.account.mockResolvedValue({ livemode: true, creditBalance: 1000 });
    await expect(requirePaidCleanupEntitlement("linked-inbox", "job-1")).rejects.toThrow();
  });
  it("renders all three packs, non-expiring copy and explicit linking without secrets or subscription actions", async () => {
    mocks.account.mockResolvedValue({ livemode: false, creditBalance: 10000, stripeCustomerId: "cus_fixture", syncedAt: new Date() });
    const html = renderToStaticMarkup(await BillingPanel());
    for (const text of ["10,000", "50,000", "100,000", "$10", "$15", "$20", "No subscription", "Link another inbox", "Check payment status"]) expect(html).toContain(text);
    expect(html).not.toMatch(/sk_test_|whsec_|price_small|cus_fixture|owner|Manage billing|Active paid subscription/);
  });
  it("hides purchases when sales are off or old recurring arrangements need review", async () => {
    vi.stubEnv("STRIPE_BILLING_ENABLED", "false");
    expect(renderToStaticMarkup(await BillingPanel())).not.toContain("$10 USD");
    vi.stubEnv("STRIPE_BILLING_ENABLED", "true");
    mocks.account.mockResolvedValue({ stripeSubscriptionId: "sub_old", livemode: false, creditBalance: 0 });
    const html = renderToStaticMarkup(await BillingPanel());
    expect(html).toContain("previous billing arrangement needs review"); expect(html).not.toContain("$10 USD");
  });
});
