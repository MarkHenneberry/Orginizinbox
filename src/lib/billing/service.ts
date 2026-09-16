import "server-only";
import { randomUUID } from "node:crypto";
import type { BillingAccount, CreditPurchase, PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { BillingError, type BillingConfig } from "@/lib/billing/config";
import { creditPacks, isCreditPack, type CreditPack } from "@/lib/billing/packs";
import { billingFreshMs, billingRefreshMs, billingSnapshotFresh } from "@/lib/billing/freshness";
import { billingOperation } from "@/lib/billing/operations";
import { creditOwner } from "@/lib/billing/credits";

export const billingEvents = new Set([
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "checkout.session.expired", "charge.refunded", "charge.dispute.created", "charge.dispute.closed"
]);
const leaseMs = 120_000;

export function purchaseProjection(session: Stripe.Checkout.Session, purchase: CreditPurchase, customer: string, livemode: boolean) {
  const line = session.line_items?.data[0];
  if ((purchase.stripeSessionId && session.id !== purchase.stripeSessionId) || session.mode !== "payment" ||
      session.livemode !== livemode || purchase.livemode !== livemode || session.customer !== customer ||
      session.client_reference_id !== purchase.id || session.currency !== "usd" || session.amount_total !== purchase.amountCents ||
      session.line_items?.has_more || session.line_items?.data.length !== 1 || line?.quantity !== 1 ||
      line.price?.id !== purchase.stripePriceId || line.price.type !== "one_time" ||
      line.price.unit_amount !== purchase.amountCents || line.price.currency !== "usd" || line.price.livemode !== livemode ||
      session.total_details?.amount_discount || session.total_details?.amount_tax) throw new BillingError("Payment could not be verified.");
  if (session.payment_status !== "paid" || session.status !== "complete") {
    return { granted: 0, reversed: 0, stripePaymentId: null, status: session.status === "expired" ? "expired" : "pending" };
  }
  const payment = session.payment_intent;
  if (!payment || typeof payment === "string" || payment.status !== "succeeded" || payment.livemode !== livemode ||
      payment.amount !== purchase.amountCents || payment.currency !== "usd" || payment.customer !== customer) throw new BillingError("Payment confirmation is pending.");
  const charge = payment.latest_charge;
  if (!charge || typeof charge === "string" || !charge.paid || charge.livemode !== livemode || charge.amount !== purchase.amountCents) throw new BillingError("Payment confirmation is pending.");
  const reversed = charge.disputed ? purchase.credits : Math.min(purchase.credits, Math.ceil(purchase.credits * charge.amount_refunded / purchase.amountCents));
  return { granted: purchase.credits, reversed, stripePaymentId: payment.id, status: reversed ? "reversed" : "paid" };
}

export class StripeBillingService {
  constructor(private readonly db: PrismaClient, private readonly stripe: Stripe, private readonly config: BillingConfig,
    private readonly now: () => number = Date.now) {}

  private async withLease<T>(userId: string, run: (account: BillingAccount, owner: string) => Promise<T>, retainOnFailure = false) {
    const owner = randomUUID();
    const claimed = await this.db.billingAccount.updateMany({
      where: { userId, OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: new Date(this.now()) } }] },
      data: { leaseOwner: owner, leaseExpiresAt: new Date(this.now() + leaseMs) }
    });
    if (claimed.count !== 1) throw new BillingError("Billing is updating. Try again shortly.");
    let completed = false;
    try {
      const result = await run(await this.db.billingAccount.findUniqueOrThrow({ where: { userId } }), owner);
      completed = true;
      return result;
    } finally {
      if (completed || !retainOnFailure) await this.db.billingAccount.updateMany({ where: { userId, leaseOwner: owner }, data: { leaseOwner: null, leaseExpiresAt: null } });
    }
  }

  private async fulfill(purchase: CreditPurchase, customer: string, owner: string, event?: Stripe.Event, sessionId = purchase.stripeSessionId) {
    if (!sessionId) throw new BillingError("Payment confirmation is pending. Contact support if this continues.");
    const session = await this.stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items", "payment_intent.latest_charge"] });
    const projection = purchaseProjection(session, purchase, customer, this.config.livemode);
    await this.db.$transaction(async (tx) => {
      // Serialize fulfillment against reservations, debits and Undo on the same account row.
      const locked = await tx.billingAccount.updateMany({ where: {
        userId: purchase.userId, leaseOwner: owner, leaseExpiresAt: { gt: new Date(this.now()) }
      }, data: { creditVersion: { increment: 1 } } });
      if (locked.count !== 1) throw new BillingError("Billing changed. Try again shortly.");
      if (event && await tx.stripeWebhookReceipt.findUnique({ where: { eventId: event.id } })) return;
      const current = await tx.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
      const granted = Math.max(current.granted, projection.granted);
      const reversed = Math.max(current.reversed, projection.reversed);
      const amount = granted - current.granted - (reversed - current.reversed);
      if (granted !== current.granted || reversed !== current.reversed) {
        await tx.creditEntry.create({ data: { key: `purchase:${current.id}:${granted}:${reversed}`, userId: current.userId, amount, kind: "purchase" } });
        await tx.billingAccount.update({ where: { userId: current.userId }, data: { creditBalance: { increment: amount } } });
      }
      await tx.creditPurchase.update({ where: { id: current.id }, data: {
        stripeSessionId: session.id, stripePaymentId: projection.stripePaymentId ?? current.stripePaymentId,
        granted, reversed, status: reversed ? "reversed" : granted ? "paid" : projection.status, checkedAt: new Date(this.now())
      } });
      if (event) await tx.stripeWebhookReceipt.create({ data: { eventId: event.id, userId: current.userId, eventType: event.type, livemode: event.livemode } });
    });
  }

  async reconcile(userId: string, refresh = false) {
    const account = await this.db.billingAccount.findUnique({ where: { userId } });
    if (!account?.stripeCustomerId) return account;
    if (account.livemode !== this.config.livemode) throw new BillingError("Billing mode changed. Contact support.", 409);
    if (billingSnapshotFresh(account, refresh ? billingRefreshMs : billingFreshMs, this.now())) return account;
    return this.withLease(userId, async (current, owner) => {
      billingOperation("reconciliation_required");
      try {
        const purchases = await this.db.creditPurchase.findMany({ where: { userId, stripeSessionId: { not: null } },
          orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }], take: 20 });
        for (const purchase of purchases) await this.fulfill(purchase, current.stripeCustomerId!, owner);
        const saved = await this.db.billingAccount.updateMany({ where: { userId, leaseOwner: owner, leaseExpiresAt: { gt: new Date(this.now()) } },
          data: { syncedAt: new Date(this.now()) } });
        if (saved.count !== 1) throw new BillingError("Billing changed. Try again shortly.");
        billingOperation("reconciliation_succeeded");
        return await this.db.billingAccount.findUnique({ where: { userId } });
      } catch {
        billingOperation("reconciliation_failed");
        throw new BillingError("Payment status could not be checked. Try again shortly.");
      }
    }, true);
  }

  async checkout(userId: string, packKey: CreditPack) {
    if (!this.config.checkoutEnabled) throw new BillingError("Credit purchases are not available yet.");
    if (!isCreditPack(packKey)) throw new BillingError("Choose a credit pack.", 400);
    await this.db.billingAccount.upsert({ where: { userId }, create: { userId }, update: {} });
    return this.withLease(userId, async (account, owner) => {
      if (await creditOwner(this.db, userId) !== userId) throw new BillingError("Your credit account changed. Refresh Account before purchasing.", 409);
      if (account.stripeSubscriptionId) throw new BillingError("Your earlier billing arrangement needs review. Contact support before purchasing credits.", 409);
      let customer = account.stripeCustomerId;
      if (customer && account.livemode !== this.config.livemode) throw new BillingError("Billing mode changed. Contact support.", 409);
      if (!customer) {
        const created = await this.stripe.customers.create({}, { idempotencyKey: `organizinbox-customer:${userId}` });
        if (created.livemode !== this.config.livemode) throw new BillingError("Billing could not be verified.");
        customer = created.id;
        const saved = await this.db.billingAccount.updateMany({ where: { userId, leaseOwner: owner, leaseExpiresAt: { gt: new Date(this.now()) } },
          data: { stripeCustomerId: customer, livemode: this.config.livemode } });
        if (saved.count !== 1) throw new BillingError("Billing changed. Try again shortly.");
      }
      const pack = creditPacks[packKey];
      const priceId = this.config.prices[packKey];
      const price = await this.stripe.prices.retrieve(priceId);
      if (!price.active || price.type !== "one_time" || price.recurring || price.livemode !== this.config.livemode ||
          price.billing_scheme !== "per_unit" || price.currency !== "usd" || price.unit_amount !== pack.amountCents) throw new BillingError("This credit pack is unavailable.");
      let purchase = await this.db.creditPurchase.findFirst({ where: { userId, status: "pending" }, orderBy: { createdAt: "asc" } });
      if (purchase?.stripeSessionId) {
        await this.fulfill(purchase, customer, owner);
        const existing = await this.stripe.checkout.sessions.retrieve(purchase.stripeSessionId);
        if (existing.status === "open") {
          if (purchase.pack !== packKey) throw new BillingError("Finish or let your previous checkout expire before choosing another pack.", 409);
          return this.stripeUrl(existing.url);
        }
        const updated = await this.db.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
        if (updated.status === "pending") throw new BillingError("Payment confirmation is pending. Do not pay again yet.", 409);
        purchase = null;
      }
      if (purchase && (purchase.pack !== packKey || purchase.stripePriceId !== priceId || this.now() - purchase.createdAt.getTime() >= 23 * 60 * 60 * 1000)) {
        throw new BillingError("An earlier checkout needs review. Contact support before paying again.", 409);
      }
      if (!purchase) purchase = await this.db.creditPurchase.create({ data: {
        userId, pack: packKey, stripePriceId: priceId, credits: pack.credits, amountCents: pack.amountCents,
        livemode: this.config.livemode, expiresAt: new Date((Math.floor(this.now() / 1000) + 3600) * 1000)
      } });
      const session = await this.stripe.checkout.sessions.create({
        mode: "payment", customer, client_reference_id: purchase.id,
        line_items: [{ price: priceId, quantity: 1 }], payment_method_types: ["card"],
        success_url: `${this.config.origin}/app/account?billing=returned`, cancel_url: `${this.config.origin}/app/account?billing=cancelled`,
        expires_at: Math.floor(purchase.expiresAt.getTime() / 1000),
        custom_text: { submit: { message: "One-time cleanup credits. No subscription. Credits do not expire." } }
      }, { idempotencyKey: `organizinbox-credits:${purchase.id}` });
      if (session.mode !== "payment" || session.livemode !== this.config.livemode || session.customer !== customer || session.client_reference_id !== purchase.id) throw new BillingError("Checkout could not be verified.");
      await this.db.creditPurchase.update({ where: { id: purchase.id }, data: { stripeSessionId: session.id } });
      return this.stripeUrl(session.url);
    });
  }

  async webhook(event: Stripe.Event) {
    if (event.livemode !== this.config.livemode) throw new BillingError("Webhook mode does not match.", 400);
    if (!billingEvents.has(event.type)) return { result: "ignored" as const };
    if (await this.db.stripeWebhookReceipt.findUnique({ where: { eventId: event.id } })) return { result: "duplicate" as const };
    let purchase: CreditPurchase | null;
    let sessionId: string | undefined;
    if (event.type.startsWith("checkout.session.")) {
      const session = event.data.object as Stripe.Checkout.Session;
      if (!session.client_reference_id) return { result: "ignored" as const };
      purchase = await this.db.creditPurchase.findUnique({ where: { id: session.client_reference_id } });
      sessionId = session.id;
    } else {
      const object = event.data.object as Stripe.Charge | Stripe.Dispute;
      const paymentId = typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id;
      if (!paymentId) return { result: "ignored" as const };
      purchase = await this.db.creditPurchase.findUnique({ where: { stripePaymentId: paymentId } });
    }
    if (!purchase) return { result: "ignored" as const };
    return this.withLease(purchase.userId, async (account, owner) => {
      if (!account.stripeCustomerId || account.livemode !== this.config.livemode) throw new BillingError("Payment could not be verified.");
      await this.fulfill(purchase, account.stripeCustomerId, owner, event, sessionId ?? purchase.stripeSessionId);
      return { result: "processed" as const };
    });
  }

  private stripeUrl(value: string | null) {
    if (!value) throw new BillingError("Checkout could not be verified.");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password) throw new BillingError("Checkout could not be verified.");
    return url.toString();
  }
}
