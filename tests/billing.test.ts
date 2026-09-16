import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { Prisma } from "@prisma/client";
import { resolveBillingConfig } from "@/lib/billing/config";
import { creditPacks, isCreditPack } from "@/lib/billing/packs";
import { deriveEntitlement } from "@/lib/billing/entitlements";
import { accountVerifiedProgress, creditSnapshot } from "@/lib/billing/credits";
import { StripeBillingService, purchaseProjection } from "@/lib/billing/service";
import { PrismaCleanupJobStateRepository, verifiedCreditProgress } from "@/lib/server/gmail-scalable-cleanup-durable-store";
import { billingFixture, config, environment, now, purchase, session } from "./fixtures/credit-billing";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });
const event = (id = "evt_one", purchaseId = "purchase-1") => ({ id, type: "checkout.session.completed", livemode: false,
  data: { object: { id: `cs_${purchaseId}`, client_reference_id: purchaseId } } }) as unknown as Stripe.Event;

describe("one-time credit configuration", () => {
  it("offers only the three specified USD packs", () => {
    expect(Object.values(creditPacks).map(({ credits, amountCents }) => [credits, amountCents])).toEqual([[10000, 1000], [50000, 1500], [100000, 2000]]);
    expect(isCreditPack("subscription")).toBe(false); expect(isCreditPack("__proto__")).toBe(false);
  });
  it("requires all three distinct prices and fails closed on incomplete production configuration", () => {
    expect(config.checkoutEnabled).toBe(true);
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_10000_CREDITS", "STRIPE_PRICE_50000_CREDITS", "STRIPE_PRICE_100000_CREDITS", "DATABASE_URL", "NEXT_PUBLIC_APP_URL"]) {
      expect(resolveBillingConfig({ ...environment, [name]: "" })).toBeNull();
    }
    expect(resolveBillingConfig({ ...environment, STRIPE_PRICE_50000_CREDITS: "price_small" })).toBeNull();
    expect(resolveBillingConfig({ ...environment, NODE_ENV: "production", TOKEN_ENCRYPTION_KEY: "" })).toBeNull();
    expect(resolveBillingConfig({ ...environment, STRIPE_BILLING_ENABLED: undefined })?.checkoutEnabled).toBe(false);
    expect(resolveBillingConfig({ ...environment, STRIPE_BILLING_MODE: "live" })).toBeNull();
  });
  it("bases access on non-expiring available credits, not old subscription dates", () => {
    const { row } = billingFixture(1000);
    row.currentPeriodEnd = new Date(0); row.subscriptionStatus = "canceled";
    expect(deriveEntitlement(row, false, { balance: 1000, reserved: 500, available: 500 })).toMatchObject({ paidAccess: true, periodEnd: null });
    expect(deriveEntitlement(row, true, { balance: 1000, reserved: 0, available: 1000 }).paidAccess).toBe(false);
    expect(deriveEntitlement(row, false, { balance: 500, reserved: 500, available: 0 }).paidAccess).toBe(false);
  });
});

describe("Stripe credit purchases", () => {
  it("reuses a durable pending attempt and never creates subscriptions or charges off-session", async () => {
    const f = billingFixture();
    await f.service.checkout("owner", "small"); await f.service.checkout("owner", "small");
    expect(f.purchases.size).toBe(1); expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ mode: "payment", line_items: [{ price: "price_small", quantity: 1 }] }), { idempotencyKey: "organizinbox-credits:purchase-1" });
    expect(f.row.creditBalance).toBe(0);
  });
  it("rejects recurring, wrong-amount and wrong-mode prices", async () => {
    for (const wrong of [{ type: "recurring" }, { unit_amount: 999 }, { livemode: true }, { currency: "eur" }]) {
      const f = billingFixture();
      f.stripe.prices.retrieve.mockResolvedValue({ active: true, type: "one_time", billing_scheme: "per_unit", unit_amount: 1000, currency: "usd", livemode: false, ...wrong });
      await expect(f.service.checkout("owner", "small")).rejects.toThrow("unavailable");
      expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    }
  });
  it("rejects concurrent checkout ownership and old unknown attempts", async () => {
    const f = billingFixture();
    f.row.leaseOwner = "other"; f.row.leaseExpiresAt = new Date(now + 120000);
    await expect(f.service.checkout("owner", "small")).rejects.toThrow("updating");
    f.row.leaseOwner = null;
    f.purchases.set("old", { ...purchase("old"), stripeSessionId: null, createdAt: new Date(now - 24 * 3600000) });
    await expect(f.service.checkout("owner", "small")).rejects.toThrow("earlier checkout");
  });
  it("recovers a lost checkout response using the same persistent Stripe idempotency key", async () => {
    const f = billingFixture();
    f.stripe.checkout.sessions.create.mockRejectedValueOnce(new Error("network"));
    await expect(f.service.checkout("owner", "small")).rejects.toThrow();
    await f.service.checkout("owner", "small");
    expect(f.purchases.size).toBe(1);
    expect(f.stripe.checkout.sessions.create.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: "organizinbox-credits:purchase-1" }, { idempotencyKey: "organizinbox-credits:purchase-1" }
    ]);
  });
  it("fulfills paid purchases once across replay, different event IDs and service replacement; purchases accumulate", async () => {
    const f = billingFixture(); const p = purchase();
    f.purchases.set(p.id, p); f.sessions.set(p.stripeSessionId!, session(p));
    await f.service.webhook(event()); await f.service.webhook(event()); await f.service.webhook(event("evt_two"));
    expect(f.row.creditBalance).toBe(10000); expect(f.entries.size).toBe(1);
    const p2 = purchase("purchase-2"); f.purchases.set(p2.id, p2); f.sessions.set(p2.stripeSessionId!, session(p2));
    await new StripeBillingService(f.client, f.stripe as unknown as Stripe, config, () => now).webhook(event("evt_three", p2.id));
    expect(f.row.creditBalance).toBe(20000); expect(f.entries.size).toBe(2);
  });
  it("does not trust completion redirects, client metadata, unpaid sessions, or mismatched prices", () => {
    const p = purchase(); const value = session(p);
    expect(purchaseProjection({ ...value, payment_status: "unpaid" }, p, "cus_fixture", false).granted).toBe(0);
    for (const change of [{ customer: "cus_attacker" }, { mode: "subscription" }, { client_reference_id: "another" }, { amount_total: 1 }, { currency: "eur" }, { livemode: true }]) {
      expect(() => purchaseProjection({ ...value, ...change } as Stripe.Checkout.Session, p, "cus_fixture", false)).toThrow();
    }
  });
  it("reconciles missed payment webhooks and reverses refunded/disputed credits monotonically", async () => {
    const f = billingFixture(); const p = purchase(); const value = session(p);
    f.purchases.set(p.id, p); f.sessions.set(p.stripeSessionId!, value);
    await f.service.reconcile("owner", true); expect(f.row.creditBalance).toBe(10000);
    const charge = (value.payment_intent as Stripe.PaymentIntent).latest_charge as Stripe.Charge;
    charge.amount_refunded = 500;
    await f.service.webhook(event("evt_refund")); expect(f.row.creditBalance).toBe(5000);
    charge.amount_refunded = 0;
    await f.service.webhook(event("evt_old")); expect(f.row.creditBalance).toBe(5000);
    charge.disputed = true;
    await f.service.webhook(event("evt_dispute")); expect(f.row.creditBalance).toBe(0);
  });
  it("rolls back grants if event receipt commit fails", async () => {
    const f = billingFixture(); const p = purchase(); f.purchases.set(p.id, p); f.sessions.set(p.stripeSessionId!, session(p));
    f.db.stripeWebhookReceipt.create.mockRejectedValueOnce(new Error("commit"));
    await expect(f.service.webhook(event())).rejects.toThrow(); expect(f.row.creditBalance).toBe(0);
    await f.service.webhook(event()); expect(f.row.creditBalance).toBe(10000);
  });
});

describe("verified cleanup accounting", () => {
  const progress = (moved = 0, restored = 0, closed = false) => ({ requested: 500, moved, restored, closed });
  it("reserves without spending, charges only verified moves and restores only verified Undo once", async () => {
    const f = billingFixture(1000);
    const save = (p = progress()) => f.client.$transaction((tx) => accountVerifiedProgress(tx, "owner", "job-1", p));
    await save(); expect(await creditSnapshot(f.client, "owner")).toEqual({ balance: 1000, reserved: 500, available: 500 });
    await save(progress(450)); await save(progress(450)); expect(f.row.creditBalance).toBe(550);
    await save(progress(450, 0, true)); expect((await creditSnapshot(f.client, "owner")).reserved).toBe(0);
    await save(progress(450, 400, true)); await save(progress(450, 400, true)); expect(f.row.creditBalance).toBe(950);
    await expect(save(progress(451, 400, true))).rejects.toThrow();
    await expect(save(progress(450, 451, true))).rejects.toThrow();
    expect([...f.entries.values()].map((value) => value.amount)).toEqual([-450, 400]);
  });
  it("prevents over-reservation across jobs and releases holds when transient state is deleted", async () => {
    const f = billingFixture(500);
    await accountVerifiedProgress(f.client as unknown as Prisma.TransactionClient, "owner", "job-1", progress());
    await expect(accountVerifiedProgress(f.client as unknown as Prisma.TransactionClient, "owner", "job-2", progress())).rejects.toThrow("Not enough");
    f.jobs.get("job-1")!.activeStateJobId = null; // Postgres ON DELETE SET NULL, verified in staging migration tests.
    expect((await creditSnapshot(f.client, "owner")).available).toBe(500);
    await expect(accountVerifiedProgress(f.client as unknown as Prisma.TransactionClient, "owner", "job-1", progress(1))).rejects.toThrow();
  });
  it("does not account a rejected job CAS and commits accepted accounting inside its transaction", async () => {
    const f = billingFixture(500);
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    Object.assign(f.db, { cleanupJobState: { updateMany } });
    const repository = new PrismaCleanupJobStateRepository(f.client);
    const input = { userId: "owner", jobId: "job-1", expectedVersion: 1, now: new Date(now), encryptedPayload: "ciphertext", expiresAt: new Date(now + 1000), creditProgress: progress() };
    expect(await repository.replaceIfVersion(input)).toBe(false); expect(f.jobs.size).toBe(0);
    updateMany.mockResolvedValue({ count: 1 }); expect(await repository.replaceIfVersion(input)).toBe(true); expect(f.jobs.size).toBe(1);
  });
  it("uses exact encrypted provider ledgers, not attempted counts or browser fields", () => {
    const base = { creditBilling: true as const, userId: "owner", version: 1, view: { id: "job", expiresAt: now + 1000, status: "partial", requested: 5 },
      provider: "microsoft", payload: { confirmedAt: now, targets: [{ state: "moved_verified" }, { state: "restored_verified" }, { state: "move_uncertain" }, { state: "move_failed" }, { state: "excluded" }] } };
    expect(verifiedCreditProgress(base)).toEqual({ requested: 5, moved: 2, restored: 1, closed: true });
    expect(verifiedCreditProgress({ ...base, creditBilling: undefined })).toBeUndefined();
    const unconfirmed = { ...base, payload: { ...base.payload, confirmedAt: undefined } };
    expect(verifiedCreditProgress(unconfirmed)).toBeUndefined();
  });
});
