import "server-only";
import { randomUUID } from "node:crypto";
import type { BillingAccount, Prisma, PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { BillingError, type BillingConfig } from "@/lib/billing/config";
import { billingFreshMs, billingRefreshMs, billingSnapshotFresh } from "@/lib/billing/freshness";
import { billingOperation } from "@/lib/billing/operations";

export const billingEvents = new Set([
  "checkout.session.completed", "customer.subscription.created", "customer.subscription.updated",
  "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"
]);
const terminalSubscriptions = new Set(["canceled", "incomplete_expired"]);
const leaseMs = 120_000;

export function subscriptionProjection(subscriptions: Stripe.Subscription[], config: BillingConfig) {
  const current = subscriptions.filter((item) => !terminalSubscriptions.has(item.status));
  if (current.length > 1) throw new BillingError("Billing needs review. Manage your subscriptions or contact support.", 409);
  const subscription = current[0] ?? [...subscriptions].sort((a, b) => b.created - a.created)[0];
  if (!subscription) return {
    stripeSubscriptionId: null, stripePriceId: null, subscriptionStatus: "free",
    latestInvoicePaid: false, currentPeriodEnd: null, cancelAtPeriodEnd: false, livemode: config.livemode
  };
  const item = subscription.items.data[0];
  const validItem = subscription.items.data.length === 1 && !subscription.items.has_more && item?.quantity === 1 &&
    item.price.id === config.priceId && item.price.type === "recurring" && subscription.livemode === config.livemode;
  const invoice = subscription.latest_invoice;
  const paid = Boolean(validItem && invoice && typeof invoice !== "string" && invoice.status === "paid");
  const end = item?.current_period_end;
  return {
    stripeSubscriptionId: subscription.id, stripePriceId: validItem ? item.price.id : null,
    subscriptionStatus: subscription.status, latestInvoicePaid: paid,
    currentPeriodEnd: typeof end === "number" && Number.isSafeInteger(end) && end > 0 ? new Date(end * 1000) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end, livemode: subscription.livemode
  };
}

export class StripeBillingService {
  constructor(private readonly db: PrismaClient, private readonly stripe: Stripe, private readonly config: BillingConfig,
    private readonly now: () => number = Date.now) {}

  private async withLease<T>(userId: string, run: (account: BillingAccount, owner: string) => Promise<T>, retainOnFailure = false) {
    const owner = randomUUID();
    const now = new Date(this.now());
    const claimed = await this.db.billingAccount.updateMany({
      where: { userId, OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: now } }] },
      data: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + leaseMs) }
    });
    if (claimed.count !== 1) throw new BillingError("Billing is updating. Try again shortly.", 503);
    let completed = false;
    try {
      const account = await this.db.billingAccount.findUniqueOrThrow({ where: { userId } });
      const result = await run(account, owner);
      completed = true;
      return result;
    } finally {
      if (completed || !retainOnFailure) {
        await this.db.billingAccount.updateMany({ where: { userId, leaseOwner: owner }, data: { leaseOwner: null, leaseExpiresAt: null } });
      }
    }
  }

  private async save(userId: string, owner: string, data: Prisma.BillingAccountUpdateManyMutationInput, event?: Stripe.Event) {
    await this.db.$transaction(async (tx) => {
      if (event && await tx.stripeWebhookReceipt.findUnique({ where: { eventId: event.id } })) return;
      const saved = await tx.billingAccount.updateMany({
        where: { userId, leaseOwner: owner, leaseExpiresAt: { gt: new Date(this.now()) } }, data
      });
      if (saved.count !== 1) throw new BillingError("Billing changed during processing. Try again shortly.");
      if (event) await tx.stripeWebhookReceipt.create({ data: { eventId: event.id, userId, eventType: event.type, livemode: event.livemode } });
    });
  }

  private async subscriptions(customer: string) {
    const list = await this.stripe.subscriptions.list({ customer, status: "all", limit: 100, expand: ["data.latest_invoice"] });
    if (list.has_more) throw new BillingError("Billing history needs review. Contact support.");
    if (list.data.some((subscription) => subscription.livemode !== this.config.livemode ||
        (typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id) !== customer)) {
      throw new BillingError("Billing could not be verified.");
    }
    return list.data;
  }

  async reconcile(userId: string, refresh = false) {
    const maxAge = refresh ? billingRefreshMs : billingFreshMs;
    try {
      const account = await this.db.billingAccount.findUnique({ where: { userId } });
      if (!account?.stripeCustomerId) return account;
      if (account.livemode !== this.config.livemode) throw new BillingError("Billing mode changed. Contact support.", 409);
      if (account.leaseOwner && account.leaseExpiresAt && account.leaseExpiresAt.getTime() > this.now()) {
        throw new BillingError("Billing is updating. Try again shortly.");
      }
      if (billingSnapshotFresh(account, maxAge, this.now())) return account;
      billingOperation("reconciliation_required");
      return await this.withLease(userId, async (current, owner) => {
        if (billingSnapshotFresh(current, maxAge, this.now())) return current;
        if (!current.stripeCustomerId || current.livemode !== this.config.livemode) throw new BillingError("Billing could not be verified.");
        const subscriptions = await this.subscriptions(current.stripeCustomerId);
        const data = { ...subscriptionProjection(subscriptions, this.config), syncedAt: new Date(this.now()) };
        await this.save(userId, owner, data);
        billingOperation("reconciliation_succeeded");
        return { ...current, ...data };
      }, true);
    } catch {
      billingOperation("reconciliation_failed");
      throw new BillingError("Billing access could not be verified. Wait two minutes, then refresh billing status.");
    }
  }

  async checkout(userId: string) {
    if (!this.config.checkoutEnabled) throw new BillingError("New subscriptions are not available.");
    await this.db.billingAccount.upsert({ where: { userId }, create: { userId }, update: {} });
    return this.withLease(userId, async (account, owner) => {
      let customer = account.stripeCustomerId;
      if (customer && account.livemode !== this.config.livemode) throw new BillingError("Billing mode changed. Contact support.", 409);
      if (!customer) {
        const created = await this.stripe.customers.create({}, { idempotencyKey: `organizinbox-customer:${userId}` });
        if (created.livemode !== this.config.livemode) throw new BillingError("Billing could not be verified.");
        customer = created.id;
        await this.save(userId, owner, { stripeCustomerId: customer, livemode: this.config.livemode });
      }
      const subscriptions = await this.subscriptions(customer);
      await this.save(userId, owner, { ...subscriptionProjection(subscriptions, this.config), syncedAt: new Date(this.now()) });
      if (subscriptions.some((item) => !terminalSubscriptions.has(item.status))) {
        throw new BillingError("You already have a subscription. Use Manage billing.", 409);
      }
      let reuseAttempt = Boolean(account.checkoutAttemptKey);
      if (account.checkoutSessionId) {
        const existing = await this.stripe.checkout.sessions.retrieve(account.checkoutSessionId);
        if (existing.customer !== customer || existing.livemode !== this.config.livemode) throw new BillingError("Billing could not be verified.");
        if (existing.status === "open" && existing.url) {
          if (account.checkoutPriceId !== this.config.priceId) throw new BillingError("A previous checkout needs review. Contact support.", 409);
          return this.stripeUrl(existing.url, "checkout.stripe.com");
        }
        // Require this checkout's subscription, not an unrelated historical cancellation.
        if (existing.status === "complete") {
          const id = typeof existing.subscription === "string" ? existing.subscription : existing.subscription?.id;
          if (!id || !subscriptions.some((item) => item.id === id && terminalSubscriptions.has(item.status))) {
            throw new BillingError("Subscription confirmation is pending. Try again shortly.");
          }
        }
        if (existing.status !== "complete" && existing.status !== "expired") throw new BillingError("A previous checkout could not be verified.");
        reuseAttempt = false;
      }
      const price = await this.stripe.prices.retrieve(this.config.priceId);
      if (!price.active || price.type !== "recurring" || price.livemode !== this.config.livemode ||
          price.billing_scheme !== "per_unit" || price.unit_amount === null) throw new BillingError("The subscription price is unavailable.");
      if (reuseAttempt && (account.checkoutPriceId !== this.config.priceId || !account.checkoutAttemptedAt ||
          this.now() - account.checkoutAttemptedAt.getTime() >= 23 * 60 * 60 * 1000)) {
        throw new BillingError("A previous checkout could not be confirmed. Contact support before trying again.", 409);
      }
      const key = reuseAttempt ? account.checkoutAttemptKey! : randomUUID();
      const expiresAt = reuseAttempt ? account.checkoutExpiresAt! : new Date((Math.floor(this.now() / 1000) + 3600) * 1000);
      if (!expiresAt) throw new BillingError("A previous checkout needs review. Contact support.", 409);
      if (!reuseAttempt) await this.save(userId, owner, {
        checkoutAttemptKey: key, checkoutAttemptedAt: new Date(this.now()), checkoutPriceId: this.config.priceId,
        checkoutSessionId: null, checkoutExpiresAt: expiresAt
      });
      const session = await this.stripe.checkout.sessions.create({
        mode: "subscription", customer, client_reference_id: userId,
        line_items: [{ price: this.config.priceId, quantity: 1 }], payment_method_types: ["card"],
        success_url: `${this.config.origin}/app/account?billing=returned`, cancel_url: `${this.config.origin}/app/account?billing=cancelled`,
        expires_at: Math.floor(expiresAt.getTime() / 1000),
        custom_text: { submit: { message: "This is a recurring subscription. Production cleanup is not available yet." } }
      }, { idempotencyKey: `organizinbox-checkout:${key}` });
      if (!session.url || session.livemode !== this.config.livemode || session.customer !== customer) throw new BillingError("Checkout could not be verified.");
      await this.save(userId, owner, { checkoutSessionId: session.id });
      return this.stripeUrl(session.url, "checkout.stripe.com");
    });
  }

  async portal(userId: string) {
    const account = await this.db.billingAccount.findUnique({ where: { userId } });
    if (!account?.stripeCustomerId || account.livemode !== this.config.livemode) throw new BillingError("No billing account is available.", 409);
    const session = await this.stripe.billingPortal.sessions.create({ customer: account.stripeCustomerId, return_url: `${this.config.origin}/app/account` });
    return this.stripeUrl(session.url, "billing.stripe.com");
  }

  async webhook(event: Stripe.Event) {
    if (event.livemode !== this.config.livemode) throw new BillingError("Webhook mode does not match.", 400);
    if (!billingEvents.has(event.type)) return { result: "ignored" as const };
    if (await this.db.stripeWebhookReceipt.findUnique({ where: { eventId: event.id } })) return { result: "duplicate" as const };
    const object = event.data.object as unknown as { customer?: string | { id: string } | null };
    const customer = typeof object.customer === "string" ? object.customer : object.customer?.id;
    if (!customer) throw new BillingError("Webhook customer is missing.", 400);
    const account = await this.db.billingAccount.findUnique({ where: { stripeCustomerId: customer } });
    if (!account) return { result: "ignored" as const };
    if (account.livemode !== this.config.livemode) throw new BillingError("Webhook mode does not match.", 400);
    return this.withLease(account.userId, async (_, owner) => {
      if (await this.db.stripeWebhookReceipt.findUnique({ where: { eventId: event.id } })) return { result: "duplicate" as const };
      const subscriptions = await this.subscriptions(customer);
      await this.save(account.userId, owner, { ...subscriptionProjection(subscriptions, this.config), syncedAt: new Date(this.now()) }, event);
      return { result: "processed" as const };
    });
  }

  private stripeUrl(value: string, hostname: string) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== hostname || url.username || url.password) throw new BillingError("Billing redirect could not be verified.");
    return url.toString();
  }
}
