import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingAccount, PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { resolveBillingConfig, type BillingConfig } from "@/lib/billing/config";
import { deriveEntitlement } from "@/lib/billing/entitlements";
import { StripeBillingService, subscriptionProjection } from "@/lib/billing/service";

const now = Date.UTC(2026, 8, 9);
const environment = { NODE_ENV: "test", STRIPE_BILLING_ENABLED: "true", STRIPE_BILLING_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture", STRIPE_SUBSCRIPTION_PRICE_ID: "price_fixture",
  NEXT_PUBLIC_APP_URL: "https://example.test", DATABASE_URL: "postgresql://localhost/fixture", TOKEN_ENCRYPTION_KEY: "t".repeat(32) };
const config = resolveBillingConfig(environment)!;
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

function account(userId = "user-1"): BillingAccount {
  return { userId, stripeCustomerId: "cus_fixture", stripeSubscriptionId: null, stripePriceId: null, subscriptionStatus: "free",
    latestInvoicePaid: false, currentPeriodEnd: null, cancelAtPeriodEnd: false, livemode: false, syncedAt: null,
    leaseOwner: null, leaseExpiresAt: null, checkoutAttemptKey: null, checkoutAttemptedAt: null, checkoutPriceId: null,
    checkoutSessionId: null, checkoutExpiresAt: null, createdAt: new Date(now), updatedAt: new Date(now) };
}
function subscription(status = "active") {
  return { id: "sub_fixture", customer: "cus_fixture", livemode: false, status, created: Math.floor(now / 1000), cancel_at_period_end: false,
    latest_invoice: { status: "paid" }, items: { has_more: false, data: [{ quantity: 1, current_period_end: now / 1000 + 3600,
      price: { id: "price_fixture", type: "recurring" } }] } } as unknown as Stripe.Subscription;
}
function event(id = "evt_fixture", type = "customer.subscription.updated") {
  return { id, type, livemode: false, data: { object: { customer: "cus_fixture", metadata: { userId: "attacker" } } } } as unknown as Stripe.Event;
}

function fixture(initial = account(), billingConfig: BillingConfig = config) {
  let row = structuredClone(initial);
  let time = now;
  const receipts = new Map<string, unknown>();
  const lookup = ({ where }: { where: { userId?: string; stripeCustomerId?: string } }) =>
    (!where.userId || where.userId === row.userId) && (!where.stripeCustomerId || where.stripeCustomerId === row.stripeCustomerId) ? structuredClone(row) : null;
  const db = {
    billingAccount: {
      upsert: vi.fn(async () => structuredClone(row)), findUnique: vi.fn(async (input) => lookup(input)),
      findUniqueOrThrow: vi.fn(async () => structuredClone(row)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.userId !== row.userId || (where.leaseOwner && row.leaseOwner !== where.leaseOwner) ||
            (where.leaseExpiresAt?.gt && (!row.leaseExpiresAt || row.leaseExpiresAt <= where.leaseExpiresAt.gt)) ||
            (where.OR && row.leaseOwner && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > time)) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      })
    },
    stripeWebhookReceipt: { findUnique: vi.fn(async ({ where }) => receipts.get(where.eventId) ?? null),
      create: vi.fn(async ({ data }) => { if (receipts.has(data.eventId)) throw new Error("duplicate receipt"); receipts.set(data.eventId, data); return data; }) },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const previous = structuredClone(row);
      const oldReceipts = new Map(receipts);
      try { return await callback(db); }
      catch (error) { row = previous; receipts.clear(); for (const [key, value] of oldReceipts) receipts.set(key, value); throw error; }
    })
  };
  const requests = new Map<string, { id: string; url: string; status: string; customer: string; livemode: boolean }>();
  const stripe = {
    subscriptions: { list: vi.fn(async () => ({ data: [] as Stripe.Subscription[], has_more: false })) },
    customers: { create: vi.fn(async () => ({ id: "cus_fixture", livemode: false })) },
    prices: { retrieve: vi.fn(async () => ({ active: true, type: "recurring", billing_scheme: "per_unit", unit_amount: 1234, livemode: false })) },
    checkout: { sessions: {
      create: vi.fn(async (_params, { idempotencyKey }: { idempotencyKey: string }) => {
        if (!requests.has(idempotencyKey)) requests.set(idempotencyKey, { id: "cs_fixture", url: "https://checkout.stripe.com/c/pay/fixture",
          status: "open", customer: "cus_fixture", livemode: false });
        return requests.get(idempotencyKey)!;
      }),
      retrieve: vi.fn(async () => ({ id: "cs_fixture", url: "https://checkout.stripe.com/c/pay/fixture", status: "open", customer: "cus_fixture", livemode: false }))
    } },
    billingPortal: { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.com/p/session/fixture" })) } }
  };
  return { db, stripe, receipts, requests, get row() { return row; }, set row(value) { row = value; },
    setTime(value: number) { time = value; },
    service: new StripeBillingService(db as unknown as PrismaClient, stripe as unknown as Stripe, billingConfig, () => time) };
}

describe("billing configuration and entitlement", () => {
  it("fails closed for missing, unsafe and mismatched configuration", () => {
    expect(resolveBillingConfig({})).toBeNull();
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_SUBSCRIPTION_PRICE_ID", "DATABASE_URL", "NEXT_PUBLIC_APP_URL"]) {
      expect(resolveBillingConfig({ ...environment, [name]: "" }), name).toBeNull();
    }
    expect(resolveBillingConfig({ ...environment, NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toBeNull();
    expect(resolveBillingConfig({ ...environment, STRIPE_SECRET_KEY: "sk_live_fixture" })).toBeNull();
    expect(resolveBillingConfig({ ...environment, STRIPE_BILLING_MODE: "live", STRIPE_SECRET_KEY: "sk_live_fixture" })).toBeNull();
    expect(resolveBillingConfig({ ...environment, NODE_ENV: "production", STRIPE_BILLING_MODE: "live", STRIPE_SECRET_KEY: "sk_live_fixture" })?.livemode).toBe(true);
    expect(resolveBillingConfig({ ...environment, STRIPE_BILLING_ENABLED: undefined })?.checkoutEnabled).toBe(false);
  });
  it.each(["active", "past_due", "canceled", "unpaid", "paused", "incomplete", "incomplete_expired", "trialing"])(
    "derives access from durable %s status, not redirects", (status) => {
      const row = { ...account(), ...subscriptionProjection([subscription(status)], config) };
      expect(deriveEntitlement(row, config.priceId, false, now).paidAccess).toBe(status === "active");
    }
  );
  it("retains cancelled-at-period-end access only until the exact period boundary", () => {
    const row = { ...account(), ...subscriptionProjection([subscription()], config), cancelAtPeriodEnd: true };
    expect(deriveEntitlement(row, config.priceId, false, now).state).toBe("cancelled_active");
    expect(deriveEntitlement(row, config.priceId, false, row.currentPeriodEnd!.getTime()).paidAccess).toBe(false);
    expect(deriveEntitlement({ ...row, subscriptionStatus: "canceled" }, config.priceId, false, now).paidAccess).toBe(false);
    expect(deriveEntitlement({ ...row, latestInvoicePaid: false }, config.priceId, false, now).paidAccess).toBe(false);
    expect(deriveEntitlement(row, "price_other", false, now).paidAccess).toBe(false);
    expect(deriveEntitlement(row, config.priceId, true, now).paidAccess).toBe(false);
    expect(deriveEntitlement(null, config.priceId, false, now).state).toBe("free");
  });
  it("does not grant access to an unrelated price or ambiguous multiple subscriptions", () => {
    const other = subscription(); other.items.data[0].price.id = "price_other";
    expect(subscriptionProjection([other], config).latestInvoicePaid).toBe(false);
    expect(() => subscriptionProjection([subscription(), subscription()], config)).toThrow("needs review");
  });
});

describe("Stripe checkout and portal", () => {
  it("creates server-owned checkout and reuses an existing open session", async () => {
    const f = fixture({ ...account(), stripeCustomerId: null });
    await f.service.checkout("user-1");
    await f.service.checkout("user-1");
    expect(f.stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(f.stripe.checkout.sessions.create.mock.calls[0][0]).toMatchObject({ mode: "subscription", customer: "cus_fixture",
      line_items: [{ price: config.priceId, quantity: 1 }], success_url: "https://example.test/app/account?billing=returned" });
    expect(deriveEntitlement(f.row, config.priceId, false, now).paidAccess).toBe(false);
  });
  it("reuses durable attempt after a lost response and refuses attempts older than Stripe idempotency retention", async () => {
    const f = fixture();
    f.stripe.checkout.sessions.create.mockRejectedValueOnce(new Error("lost response"));
    await expect(f.service.checkout("user-1")).rejects.toThrow("lost response");
    const key = f.row.checkoutAttemptKey;
    await f.service.checkout("user-1");
    expect(f.row.checkoutAttemptKey).toBe(key);
    expect(f.stripe.checkout.sessions.create.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      `organizinbox-checkout:${key}`, `organizinbox-checkout:${key}`
    ]);
    f.row.checkoutSessionId = null;
    f.setTime(now + 24 * 3600_000);
    await expect(f.service.checkout("user-1")).rejects.toThrow("Contact support");
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
  });
  it("does not create duplicate subscriptions for active, delinquent or incomplete customers", async () => {
    const f = fixture();
    for (const status of ["active", "past_due", "unpaid", "incomplete", "trialing", "paused"]) {
      f.stripe.subscriptions.list.mockResolvedValue({ data: [subscription(status)], has_more: false });
      await expect(f.service.checkout("user-1")).rejects.toThrow("already have a subscription");
    }
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("requires the exact completed checkout subscription to be terminal before allowing a new purchase", async () => {
    const f = fixture();
    await f.service.checkout("user-1");
    const old = subscription("canceled"); old.id = "sub_old";
    f.stripe.subscriptions.list.mockResolvedValue({ data: [old], has_more: false });
    f.stripe.checkout.sessions.retrieve.mockResolvedValue({ id: "cs_fixture", url: "", status: "complete",
      customer: "cus_fixture", livemode: false, ...{ subscription: "sub_current" } });
    await expect(f.service.checkout("user-1")).rejects.toThrow("confirmation is pending");
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const current = subscription("canceled"); current.id = "sub_current";
    f.stripe.subscriptions.list.mockResolvedValue({ data: [old, current], has_more: false });
    await f.service.checkout("user-1");
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
    expect(f.stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey)
      .not.toBe(f.stripe.checkout.sessions.create.mock.calls[1][1].idempotencyKey);
  });
  it("fences concurrent attempts and releases ownership after failure", async () => {
    const f = fixture();
    let release!: () => void;
    f.stripe.subscriptions.list.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; }); return { data: [], has_more: false };
    });
    const first = f.service.checkout("user-1");
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(f.service.checkout("user-1")).rejects.toThrow("Billing is updating");
    release(); await first;
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(f.row.leaseOwner).toBeNull();
  });
  it("uses only the authenticated owner's stored customer for portal access", async () => {
    const f = fixture();
    await expect(f.service.portal("another-user")).rejects.toThrow("No billing account");
    await f.service.portal("user-1");
    expect(f.stripe.billingPortal.sessions.create).toHaveBeenCalledExactlyOnceWith({ customer: "cus_fixture", return_url: "https://example.test/app/account" });
  });
  it("rejects disabled checkout, invalid price and unexpected redirect hosts", async () => {
    const disabled = fixture(account(), { ...config, checkoutEnabled: false });
    await expect(disabled.service.checkout("user-1")).rejects.toThrow("not available");
    expect(disabled.db.billingAccount.upsert).not.toHaveBeenCalled();
    const f = fixture();
    f.stripe.prices.retrieve.mockResolvedValueOnce({ active: false, type: "one_time", billing_scheme: "per_unit", unit_amount: 1, livemode: false });
    await expect(f.service.checkout("user-1")).rejects.toThrow("price is unavailable");
    f.stripe.billingPortal.sessions.create.mockResolvedValueOnce({ url: "https://attacker.test" });
    await expect(f.service.portal("user-1")).rejects.toThrow("redirect could not be verified");
  });
});

describe("durable webhook reconciliation", () => {
  it("atomically records a receipt and paid state; duplicate delivery does no additional work", async () => {
    const f = fixture();
    f.stripe.subscriptions.list.mockResolvedValue({ data: [subscription()], has_more: false });
    await expect(f.service.webhook(event())).resolves.toEqual({ result: "processed" });
    await expect(f.service.webhook(event())).resolves.toEqual({ result: "duplicate" });
    expect(f.receipts.size).toBe(1);
    expect(f.row.userId).toBe("user-1");
    expect(f.stripe.subscriptions.list).toHaveBeenCalledTimes(1);
    expect(deriveEntitlement(f.row, config.priceId, false, now).paidAccess).toBe(true);
    expect(JSON.stringify([...f.receipts.values()])).not.toMatch(/cus_fixture|sub_fixture|metadata|attacker|data.object/);
    expect(Object.keys([...f.receipts.values()][0] as object).sort()).toEqual(["eventId", "eventType", "livemode", "userId"]);
  });
  it("uses current Stripe state for out-of-order invoice and subscription events", async () => {
    const f = fixture();
    f.stripe.subscriptions.list.mockResolvedValue({ data: [subscription("canceled")], has_more: false });
    await f.service.webhook(event("evt_oldpaid", "invoice.paid"));
    expect(deriveEntitlement(f.row, config.priceId, false, now).paidAccess).toBe(false);
    f.stripe.subscriptions.list.mockResolvedValue({ data: [subscription()], has_more: false });
    await f.service.webhook(event("evt_oldfailed", "invoice.payment_failed"));
    expect(deriveEntitlement(f.row, config.priceId, false, now).paidAccess).toBe(true);
  });
  it("rolls back entitlement changes if receipt persistence fails, and permits retry", async () => {
    const f = fixture();
    f.stripe.subscriptions.list.mockResolvedValue({ data: [subscription()], has_more: false });
    f.db.stripeWebhookReceipt.create.mockRejectedValueOnce(new Error("database failure"));
    await expect(f.service.webhook(event())).rejects.toThrow("database failure");
    expect(f.receipts.size).toBe(0);
    expect(f.row.stripeSubscriptionId).toBeNull();
    await f.service.webhook(event());
    expect(f.receipts.size).toBe(1);
  });
  it("rejects stale worker commits, wrong-mode events and unmapped customers", async () => {
    const f = fixture();
    await expect(f.service.webhook({ ...event(), livemode: true })).rejects.toThrow("mode");
    const unknown = event(); (unknown.data.object as unknown as { customer: string }).customer = "cus_other";
    expect(await f.service.webhook(unknown)).toEqual({ result: "ignored" });
    f.stripe.subscriptions.list.mockImplementationOnce(async () => {
      f.setTime(now + 121_000); return { data: [subscription()], has_more: false };
    });
    await expect(f.service.webhook(event())).rejects.toThrow("Billing changed");
    expect(f.receipts.size).toBe(0);
    expect(f.row.stripeSubscriptionId).toBeNull();
  });
  it("does not consume events on Stripe failure or grant access from checkout completion alone", async () => {
    const f = fixture();
    f.stripe.subscriptions.list.mockRejectedValueOnce(new Error("Stripe unavailable"));
    await expect(f.service.webhook(event())).rejects.toThrow("Stripe unavailable");
    expect(f.receipts.size).toBe(0);
    await f.service.webhook(event("evt_checkout", "checkout.session.completed"));
    expect(deriveEntitlement(f.row, config.priceId, false, now).paidAccess).toBe(false);
  });
  it("serializes simultaneous webhook deliveries across service instances", async () => {
    const f = fixture();
    let release!: () => void;
    f.stripe.subscriptions.list.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { data: [subscription()], has_more: false };
    });
    const first = f.service.webhook(event());
    await vi.waitFor(() => expect(release).toBeDefined());
    const replacement = new StripeBillingService(f.db as unknown as PrismaClient, f.stripe as unknown as Stripe, config, () => now);
    await expect(replacement.webhook(event())).rejects.toThrow("Billing is updating");
    release(); await first;
    expect(await replacement.webhook(event())).toEqual({ result: "duplicate" });
    expect(f.receipts.size).toBe(1);
    expect(f.stripe.subscriptions.list).toHaveBeenCalledTimes(1);
  });
});

describe("bounded billing recovery", () => {
  it("repairs a missed paid event and a missed cancellation without consuming webhook receipts", async () => {
    const f = fixture();
    f.stripe.subscriptions.list.mockResolvedValue({ data: [subscription()], has_more: false });
    const recovered = await f.service.reconcile("user-1");
    expect(deriveEntitlement(recovered, config.priceId, false, now).paidAccess).toBe(true);
    expect(f.receipts.size).toBe(0);
    expect(f.stripe.subscriptions.list).toHaveBeenCalledExactlyOnceWith({ customer: "cus_fixture", status: "all", limit: 100, expand: ["data.latest_invoice"] });
    await f.service.reconcile("user-1");
    expect(f.stripe.subscriptions.list).toHaveBeenCalledTimes(1);
    f.setTime(now + 300_000);
    f.stripe.subscriptions.list.mockResolvedValue({ data: [subscription("canceled")], has_more: false });
    expect(deriveEntitlement(await f.service.reconcile("user-1"), config.priceId, false, now + 300_000).paidAccess).toBe(false);
    await f.service.webhook(event("evt_late_paid", "invoice.paid"));
    expect(deriveEntitlement(f.row, config.priceId, false, now + 300_000).paidAccess).toBe(false);
  });
  it("limits explicit refresh to once a minute and does no Stripe work for an unmapped account", async () => {
    const f = fixture();
    await f.service.reconcile("user-1", true);
    f.setTime(now + 59_999);
    await f.service.reconcile("user-1", true);
    expect(f.stripe.subscriptions.list).toHaveBeenCalledTimes(1);
    f.setTime(now + 60_000);
    await f.service.reconcile("user-1", true);
    expect(f.stripe.subscriptions.list).toHaveBeenCalledTimes(2);
    expect(await f.service.reconcile("another-user")).toBeNull();
    const free = fixture({ ...account(), stripeCustomerId: null });
    await free.service.reconcile("user-1");
    expect(free.stripe.subscriptions.list).not.toHaveBeenCalled();
  });
  it("retains a durable failure cooldown across process replacement, never granting stale access", async () => {
    const f = fixture({ ...account(), ...subscriptionProjection([subscription()], config), syncedAt: new Date(now - 301_000) });
    f.stripe.subscriptions.list.mockRejectedValueOnce(new Error("private Stripe response secret cus_private"));
    await expect(f.service.reconcile("user-1")).rejects.toThrow("could not be verified");
    const replacement = new StripeBillingService(f.db as unknown as PrismaClient, f.stripe as unknown as Stripe, config, () => now + 60_000);
    await expect(replacement.reconcile("user-1", true)).rejects.toThrow("could not be verified");
    expect(f.stripe.subscriptions.list).toHaveBeenCalledTimes(1);
    expect(f.row.syncedAt).toEqual(new Date(now - 301_000));
    f.setTime(now + 120_001);
    await f.service.reconcile("user-1");
    expect(f.stripe.subscriptions.list).toHaveBeenCalledTimes(2);
    expect(f.row.leaseOwner).toBeNull();
    const logs = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logs).toContain("reconciliation_failed");
    expect(logs).not.toMatch(/cus_private|secret|user-1|Stripe response/);
  });
  it("bounds large history and rejects lease-lost reconciliation without publishing or consuming events", async () => {
    const f = fixture();
    f.stripe.subscriptions.list.mockResolvedValueOnce({ data: [], has_more: true });
    await expect(f.service.reconcile("user-1")).rejects.toThrow("could not be verified");
    expect(f.row.syncedAt).toBeNull();
    expect(f.stripe.subscriptions.list).toHaveBeenCalledTimes(1);
    f.setTime(now + 120_001);
    f.stripe.subscriptions.list.mockImplementationOnce(async () => {
      f.row.leaseOwner = "replacement";
      return { data: [subscription()], has_more: false };
    });
    await expect(f.service.reconcile("user-1")).rejects.toThrow("could not be verified");
    expect(f.row.syncedAt).toBeNull();
    expect(f.row.stripeSubscriptionId).toBeNull();
    expect(f.row.leaseOwner).toBe("replacement");
    expect(f.receipts.size).toBe(0);
  });
  it("coordinates reconciliation and webhooks across processes", async () => {
    const f = fixture();
    let release!: () => void;
    f.stripe.subscriptions.list.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { data: [subscription()], has_more: false };
    });
    const first = f.service.reconcile("user-1");
    await vi.waitFor(() => expect(release).toBeDefined());
    const replacement = new StripeBillingService(f.db as unknown as PrismaClient, f.stripe as unknown as Stripe, config, () => now);
    await expect(replacement.reconcile("user-1")).rejects.toThrow("could not be verified");
    await expect(replacement.webhook(event())).rejects.toThrow("Billing is updating");
    release(); await first;
    await replacement.reconcile("user-1");
    expect(f.stripe.subscriptions.list).toHaveBeenCalledTimes(1);
    f.stripe.subscriptions.list.mockResolvedValue({ data: [subscription("past_due")], has_more: false });
    await replacement.webhook(event());
    expect(deriveEntitlement(f.row, config.priceId, false, now).state).toBe("past_due");
  });
});
