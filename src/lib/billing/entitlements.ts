import "server-only";
import type { BillingAccount } from "@prisma/client";
import { prisma } from "@/lib/server/db";
import { BillingError, getBillingConfig } from "@/lib/billing/config";
import { createStripeClient } from "@/lib/billing/stripe";
import { StripeBillingService } from "@/lib/billing/service";
import { billingOperation } from "@/lib/billing/operations";

export type Entitlement = { state: "free" | "active" | "past_due" | "inactive" | "cancelled_active"; paidAccess: boolean; periodEnd: string | null };

export function deriveEntitlement(account: BillingAccount | null, priceId: string, livemode: boolean, now = Date.now()): Entitlement {
  if (!account?.stripeCustomerId || !account.stripeSubscriptionId) return { state: "free", paidAccess: false, periodEnd: null };
  const periodEnd = account.currentPeriodEnd?.toISOString() ?? null;
  if (account.stripePriceId !== priceId || account.livemode !== livemode) return { state: "inactive", paidAccess: false, periodEnd };
  const paidAccess = account.subscriptionStatus === "active" && account.latestInvoicePaid &&
    Boolean(account.currentPeriodEnd && account.currentPeriodEnd.getTime() > now);
  return { state: paidAccess ? account.cancelAtPeriodEnd ? "cancelled_active" : "active"
    : account.subscriptionStatus === "past_due" ? "past_due" : "inactive", paidAccess, periodEnd };
}

export async function getUserEntitlement(userId: string): Promise<Entitlement> {
  const config = getBillingConfig();
  if (!config) return { state: "inactive", paidAccess: false, periodEnd: null };
  const account = await new StripeBillingService(prisma, createStripeClient(), config).reconcile(userId);
  return deriveEntitlement(account, config.priceId, config.livemode);
}

export class EntitlementDeniedError extends BillingError {
  constructor(readonly action: "upgrade" | "manage") {
    super(action === "upgrade" ? "An active paid subscription is required. Open Account to upgrade."
      : "Paid access is inactive. Open Account to manage billing.", 402);
  }
}

// Provider/production availability gates still apply after this prerequisite.
// userId must come from a validated server session or durable job ownership.
export async function requirePaidCleanupEntitlement(userId: string) {
  try {
    const entitlement = await getUserEntitlement(userId);
    if (!entitlement.paidAccess) throw new EntitlementDeniedError(entitlement.state === "free" ? "upgrade" : "manage");
    return entitlement;
  } catch (error) {
    billingOperation("entitlement_denied");
    throw error;
  }
}
