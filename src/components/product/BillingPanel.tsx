import Link from "next/link";
import { BillingActions } from "@/components/product/BillingActions";
import { getBillingConfig } from "@/lib/billing/config";
import { deriveEntitlement } from "@/lib/billing/entitlements";
import { getSession } from "@/lib/server/session";
import { prisma } from "@/lib/server/db";
import { createStripeClient } from "@/lib/billing/stripe";
import { StripeBillingService } from "@/lib/billing/service";

const labels = { free: "Free / no paid access", active: "Active paid subscription", past_due: "Past due / paid access inactive",
  inactive: "Paid access inactive", cancelled_active: "Cancelled / paid access until period end" };

async function loadBillingPanel() {
  const config = getBillingConfig();
  if (!config) return { mode: "unavailable" as const };
  try {
    const session = await getSession();
    if (!session) return { mode: "signed-out" as const };
    let account;
    let verified = true;
    try {
      account = await new StripeBillingService(prisma, createStripeClient(), config).reconcile(session.userId);
    } catch {
      verified = false;
      account = await prisma.billingAccount.findUnique({ where: { userId: session.userId } });
    }
    const entitlement = deriveEntitlement(account, config.priceId, config.livemode);
    const sameMode = !account?.stripeCustomerId || account.livemode === config.livemode;
    const hasSubscription = account?.stripeSubscriptionId && !["canceled", "incomplete_expired"].includes(account.subscriptionStatus);
    return { mode: "ready" as const, entitlement, sameMode, verified, livemode: config.livemode,
      syncedAt: account?.syncedAt?.toISOString() ?? null,
      canSubscribe: verified && config.checkoutEnabled && !hasSubscription,
      canManage: Boolean(account?.stripeCustomerId) };
  } catch { return { mode: "unavailable" as const }; }
}

export async function BillingPanel() {
  const state = await loadBillingPanel();
  return <section className="mt-8 border-t border-[var(--line)] py-6">
    <h2 className="m-0 text-2xl font-bold">Billing</h2>
    <p className="muted mt-3">Your subscription provides paid access where cleanup is available for your inbox.</p>
    {state.mode === "unavailable" ? <p className="muted">Billing is temporarily unavailable.</p> : null}
    {state.mode === "signed-out" ? <Link className="btn btn-secondary focus-ring mt-3" href="/connect">Sign in to manage billing</Link> : null}
    {state.mode === "ready" ? <>
      <p className="mt-3 font-bold">{state.verified ? labels[state.entitlement.state] : "Billing access could not be verified"}</p>
      {!state.verified ? <p className="muted text-sm">Wait two minutes, then refresh billing status. You can still manage your subscription.</p>
        : !state.entitlement.paidAccess ? <p className="muted text-sm">{state.canSubscribe ? "Upgrade in Account for paid access." : state.canManage ? "Manage billing to review your subscription or payment status." : "New subscriptions are not available yet."}</p> : null}
      {state.entitlement.periodEnd ? <p className="muted text-sm">Current period ends: {new Date(state.entitlement.periodEnd).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" })} (UTC)</p> : null}
      {process.env.NODE_ENV !== "production" && !state.livemode ? <p className="muted text-sm">Test billing. No live payment.</p> : null}
      {state.syncedAt ? <p className="muted text-sm">Last billing check: {new Date(state.syncedAt).toLocaleString("en-US", { timeZone: "UTC" })} (UTC)</p> : null}
      {!state.sameMode ? <p className="muted text-sm">Billing mode changed. Contact support.</p> : <BillingActions
        canSubscribe={state.canSubscribe} canManage={state.canManage} canRefresh={state.canManage} />}
      <p className="muted mt-3 text-sm">Subscription price and billing interval are shown in Stripe before payment. Access updates after payment confirmation.</p>
    </> : null}
  </section>;
}
