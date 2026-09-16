import { vi } from "vitest";
import type { BillingAccount, CreditPurchase, CreditJobAccounting, PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { resolveBillingConfig } from "@/lib/billing/config";
import { StripeBillingService } from "@/lib/billing/service";
export const environment = { NODE_ENV: "test", STRIPE_BILLING_ENABLED: "true", STRIPE_BILLING_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture", STRIPE_PRICE_10000_CREDITS: "price_small",
  STRIPE_PRICE_50000_CREDITS: "price_medium", STRIPE_PRICE_100000_CREDITS: "price_large",
  NEXT_PUBLIC_APP_URL: "https://example.test", DATABASE_URL: "postgresql://localhost/fixture", TOKEN_ENCRYPTION_KEY: "t".repeat(32) };
export const config = resolveBillingConfig(environment)!;
export const now = Date.UTC(2026, 8, 15);
export function purchase(id = "purchase-1"): CreditPurchase {
  return { id, userId: "owner", pack: "small", stripePriceId: "price_small", stripeSessionId: `cs_${id}`, stripePaymentId: null,
    credits: 10000, amountCents: 1000, granted: 0, reversed: 0, livemode: false, status: "pending", expiresAt: new Date(now + 3600000), checkedAt: null, createdAt: new Date(now) };
}
export function session(row: CreditPurchase): Stripe.Checkout.Session {
  return { id: row.stripeSessionId, mode: "payment", customer: "cus_fixture", client_reference_id: row.id, livemode: false,
    currency: "usd", amount_total: row.amountCents, status: "complete", payment_status: "paid", url: "https://checkout.stripe.com/c/pay/fixture",
    total_details: { amount_discount: 0, amount_tax: 0 }, line_items: { has_more: false, data: [{ quantity: 1, price: {
      id: row.stripePriceId, currency: "usd", unit_amount: row.amountCents, type: "one_time", livemode: false } }] },
    payment_intent: { id: `pi_${row.id}`, customer: "cus_fixture", status: "succeeded", amount: row.amountCents, currency: "usd", livemode: false,
      latest_charge: { id: "ch_fixture", paid: true, amount: row.amountCents, amount_refunded: 0, disputed: false, livemode: false } }
  } as unknown as Stripe.Checkout.Session;
}
type Filter = { userId?: string; leaseOwner?: string; leaseExpiresAt?: { gt: Date }; OR?: unknown };
function apply<T extends object>(row: T, data: object) {
  for (const [key, value] of Object.entries(data)) Reflect.set(row, key,
    value && typeof value === "object" && "increment" in value ? Number(Reflect.get(row, key)) + Number(value.increment) : value);
}
export function billingFixture(balance = 0) {
  const row = { userId: "owner", stripeCustomerId: "cus_fixture", stripeSubscriptionId: null, livemode: false,
    creditBalance: balance, creditVersion: 0, leaseOwner: null, leaseExpiresAt: null, syncedAt: null } as BillingAccount;
  const purchases = new Map<string, CreditPurchase>();
  const jobs = new Map<string, CreditJobAccounting>();
  const entries = new Map<string, { amount: number; kind: string; userId: string }>();
  const receipts = new Set<string>();
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const db = {
    user: { findUniqueOrThrow: vi.fn(async () => ({ creditOwnerId: null })) },
    billingAccount: {
      upsert: vi.fn(async () => ({ ...row })), findUnique: vi.fn(async () => ({ ...row })), findUniqueOrThrow: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: object }) => { apply(row, data); return { ...row }; }),
      updateMany: vi.fn(async ({ where, data }: { where: Filter; data: object }) => {
        if (where.userId !== row.userId || (where.leaseOwner && where.leaseOwner !== row.leaseOwner) ||
            (where.leaseExpiresAt?.gt && (!row.leaseExpiresAt || row.leaseExpiresAt <= where.leaseExpiresAt.gt)) ||
            (where.OR && row.leaseOwner && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now)) return { count: 0 };
        apply(row, data); return { count: 1 };
      })
    },
    creditPurchase: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; stripePaymentId?: string } }) => structuredClone(where.id ? purchases.get(where.id) ?? null : [...purchases.values()].find((item) => item.stripePaymentId === where.stripePaymentId) ?? null)),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => structuredClone(purchases.get(where.id)!)),
      findFirst: vi.fn(async () => structuredClone([...purchases.values()].find((item) => item.status === "pending") ?? null)),
      findMany: vi.fn(async () => structuredClone([...purchases.values()])),
      create: vi.fn(async ({ data }: { data: Partial<CreditPurchase> }) => { const value = { ...purchase(`purchase-${purchases.size + 1}`), stripeSessionId: null, ...data }; purchases.set(value.id, value); return structuredClone(value); }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<CreditPurchase> }) => { const value = purchases.get(where.id)!; apply(value, data); return structuredClone(value); })
    },
    creditJobAccounting: {
      findUnique: vi.fn(async ({ where }: { where: { jobId: string } }) => structuredClone(jobs.get(where.jobId) ?? null)),
      findMany: vi.fn(async () => [...jobs.values()].filter((job) => !job.closed && job.activeStateJobId)),
      create: vi.fn(async ({ data }: { data: Partial<CreditJobAccounting> & { jobId: string } }) => { const value = { userId: "owner", activeStateJobId: data.jobId, requested: 0, moved: 0, restored: 0, closed: false, ...data }; jobs.set(data.jobId, value); return { ...value }; }),
      update: vi.fn(async ({ where, data }: { where: { jobId: string }; data: object }) => { apply(jobs.get(where.jobId)!, data); return jobs.get(where.jobId); })
    },
    creditEntry: { create: vi.fn(async ({ data }: { data: { key: string; amount: number; userId: string; kind: string } }) => {
      if (entries.has(data.key)) throw new Error("duplicate ledger key"); entries.set(data.key, data); return data;
    }) },
    stripeWebhookReceipt: { findUnique: vi.fn(async ({ where }: { where: { eventId: string } }) => receipts.has(where.eventId) ? {} : null),
      create: vi.fn(async ({ data }: { data: { eventId: string } }) => { if (receipts.has(data.eventId)) throw new Error("duplicate"); receipts.add(data.eventId); return data; }) },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const before = structuredClone({ row, purchases, jobs, entries, receipts });
      try { return await run(db); }
      catch (error) {
        Object.assign(row, before.row);
        purchases.clear(); before.purchases.forEach((value, key) => purchases.set(key, value));
        jobs.clear(); before.jobs.forEach((value, key) => jobs.set(key, value));
        entries.clear(); before.entries.forEach((value, key) => entries.set(key, value));
        receipts.clear(); before.receipts.forEach((value) => receipts.add(value)); throw error;
      }
    })
  };
  const stripe = {
    customers: { create: vi.fn(async () => ({ id: "cus_fixture", livemode: false })) },
    prices: { retrieve: vi.fn(async () => ({ active: true, type: "one_time", billing_scheme: "per_unit", unit_amount: 1000, currency: "usd", livemode: false })) },
    checkout: { sessions: {
      retrieve: vi.fn(async (id: string) => structuredClone(sessions.get(id)!)),
      create: vi.fn(async (params: { client_reference_id: string }, options: { idempotencyKey: string }) => {
        void options;
        const item = purchases.get(params.client_reference_id)!;
        const value = { ...session({ ...item, stripeSessionId: `cs_${item.id}` }), status: "open" as const, payment_status: "unpaid" as const, payment_intent: null };
        sessions.set(value.id, value); return structuredClone(value);
      })
    } }
  };
  return { row, purchases, jobs, entries, receipts, sessions, db, stripe,
    client: db as unknown as PrismaClient,
    service: new StripeBillingService(db as unknown as PrismaClient, stripe as unknown as Stripe, config, () => now) };
}
