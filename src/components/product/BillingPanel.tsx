import Link from "next/link";
import { BillingActions } from "@/components/product/BillingActions";
import { getBillingConfig } from "@/lib/billing/config";
import { creditOwner, creditSnapshot } from "@/lib/billing/credits";
import { getSession } from "@/lib/server/session";
import { prisma } from "@/lib/server/db";
import { runtimeConfig } from "@/lib/config";
import { StripeBillingService } from "@/lib/billing/service";
import { createStripeClient } from "@/lib/billing/stripe";

async function load() {
  const config = getBillingConfig();
  if (!config) return null;
  const session = await getSession();
  if (!session) return null;
  const owner = await creditOwner(prisma, session.userId);
  const account = await new StripeBillingService(prisma, createStripeClient(), config).reconcile(owner);
  const sameMode = !account?.stripeCustomerId || account.livemode === config.livemode;
  return { ...await creditSnapshot(prisma, owner), canBuy: sameMode && config.checkoutEnabled && !account?.stripeSubscriptionId,
    needsReview: !sameMode || Boolean(account?.stripeSubscriptionId), linked: await prisma.user.count({ where: { creditOwnerId: owner } }),
    canRefresh: sameMode && Boolean(account?.stripeCustomerId), livemode: config.livemode };
}

export async function BillingPanel() {
  const state = await load().catch(() => null);
  return <section className="account-billing mt-8 border-t border-[var(--line)] py-6">
    <h2 className="m-0 text-2xl font-bold">Cleanup credits</h2>
    <p className="muted mt-3">Pay once. No subscription. Credits don&apos;t expire.</p>
    {state ? <>
      <dl className="credit-balances mt-4">{[["Available", state.available], ["Reserved for active cleanup", state.reserved], ["Total balance", state.balance]].map(([label, value]) =>
        <div key={label}><dt className="muted text-sm">{label}</dt><dd className="m-0 text-2xl font-bold">{Number(value).toLocaleString("en-US")}</dd></div>)}</dl>
      <p className="muted mt-4">One credit is spent only when an email is verified as moved. Verified Undo returns the credit. Reserved credits are not spent.</p>
      {state.needsReview ? <p role="alert">Your previous billing arrangement needs review. Contact support before purchasing credits.</p> : null}
      {state.balance < 0 ? <p role="alert">A refunded or disputed purchase needs attention before starting more cleanup.</p> : null}
      {!state.canBuy ? <p className="muted">New credit purchases are currently unavailable.</p> : null}
      {process.env.NODE_ENV !== "production" && !state.livemode ? <p className="muted text-sm">Test billing. No live payment.</p> : null}
      <BillingActions canBuy={state.canBuy} canRefresh={state.canRefresh} gmail={runtimeConfig.gmailAvailable} microsoft={runtimeConfig.microsoftAvailable} />
      <p className="muted text-sm">{state.linked + 1} inbox {state.linked ? "identities share" : "identity uses"} this credit balance. Link another inbox before buying credits there. One inbox is active at a time; reconnect a linked inbox to use its report.</p>
    </> : <p className="muted">Credit purchases are temporarily unavailable. <Link href="/connect">Connect an available inbox</Link> to get started.</p>}
  </section>;
}
