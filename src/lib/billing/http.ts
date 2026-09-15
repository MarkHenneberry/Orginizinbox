import "server-only";
import { getSession } from "@/lib/server/session";
import { prisma } from "@/lib/server/db";
import { BillingError, requireBillingConfig } from "@/lib/billing/config";
import { createStripeClient } from "@/lib/billing/stripe";
import { StripeBillingService } from "@/lib/billing/service";
import { deriveEntitlement } from "@/lib/billing/entitlements";
import { billingOperation } from "@/lib/billing/operations";

export async function billingAction(request: Request, action: "checkout" | "portal" | "reconcile") {
  try {
    const config = requireBillingConfig();
    if (request.headers.get("origin") !== config.origin || new URL(request.url).origin !== config.origin) {
      return Response.json({ error: "Forbidden." }, { status: 403 });
    }
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Sign in before managing billing." }, { status: 401 });
    const service = new StripeBillingService(prisma, createStripeClient(), config);
    if (action === "reconcile") {
      const account = await service.reconcile(session.userId, true);
      return Response.json({ entitlement: deriveEntitlement(account, config.priceId, config.livemode) }, { headers: { "Cache-Control": "no-store" } });
    }
    // Client body, prices, customer IDs and redirects are intentionally not inputs.
    const url = await service[action](session.userId);
    if (request.headers.get("accept")?.includes("application/json")) return Response.json({ url }, { headers: { "Cache-Control": "no-store" } });
    return Response.redirect(url, 303);
  } catch (error) {
    if (action === "checkout") billingOperation("checkout_failed");
    return Response.json({ error: error instanceof BillingError ? error.message : "Billing could not be updated. Try again shortly." },
      { status: error instanceof BillingError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
