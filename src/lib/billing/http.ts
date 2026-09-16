import "server-only";
import { getSession } from "@/lib/server/session";
import { prisma } from "@/lib/server/db";
import { BillingError, requireBillingConfig } from "@/lib/billing/config";
import { createStripeClient } from "@/lib/billing/stripe";
import { StripeBillingService } from "@/lib/billing/service";
import { deriveEntitlement } from "@/lib/billing/entitlements";
import { creditOwner, creditSnapshot } from "@/lib/billing/credits";
import { isCreditPack } from "@/lib/billing/packs";
import { billingOperation } from "@/lib/billing/operations";

export async function billingAction(request: Request, action: "checkout" | "portal" | "reconcile") {
  if (action === "portal") return Response.json({ error: "Subscriptions are not offered." }, { status: 404 });
  try {
    const config = requireBillingConfig();
    if (request.headers.get("origin") !== config.origin || new URL(request.url).origin !== config.origin) {
      return Response.json({ error: "Forbidden." }, { status: 403 });
    }
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Sign in before managing billing." }, { status: 401 });
    const service = new StripeBillingService(prisma, createStripeClient(), config);
    const owner = await creditOwner(prisma, session.userId);
    if (action === "reconcile") {
      const account = await service.reconcile(owner, true);
      return Response.json({ entitlement: deriveEntitlement(account, config.livemode, await creditSnapshot(prisma, owner)) }, { headers: { "Cache-Control": "no-store" } });
    }
    const body = await request.json().catch(() => null);
    if (!isCreditPack(body?.pack)) throw new BillingError("Choose a credit pack.", 400);
    const url = await service.checkout(owner, body.pack);
    if (request.headers.get("accept")?.includes("application/json")) return Response.json({ url }, { headers: { "Cache-Control": "no-store" } });
    return Response.redirect(url, 303);
  } catch (error) {
    if (action === "checkout") billingOperation("checkout_failed");
    return Response.json({ error: error instanceof BillingError ? error.message : "Billing could not be updated. Try again shortly." },
      { status: error instanceof BillingError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
