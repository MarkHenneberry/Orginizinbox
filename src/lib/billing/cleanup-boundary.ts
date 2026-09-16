import "server-only";
import { getSession } from "@/lib/server/session";
import { BillingError, requireBillingConfig } from "@/lib/billing/config";
import { EntitlementDeniedError, requirePaidCleanupEntitlement } from "@/lib/billing/entitlements";
import { ProductionCleanupError, requireProductionCleanupAccess, type CleanupProvider, type CleanupAccess } from "@/lib/server/production-cleanup";

export async function productionCleanupBoundary(request: Request, operation?: {
  provider: CleanupProvider; access: CleanupAccess; jobId?: string;
}): Promise<Response | null> {
  if (process.env.NODE_ENV !== "production") return null;
  const headers = { "Cache-Control": "no-store" };
  try {
    // Recovery does not require working Stripe configuration or unspent credits.
    const origin = operation?.access === "recovery"
      ? new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").origin : requireBillingConfig().origin;
    if (request.headers.get("origin") !== origin || new URL(request.url).origin !== origin) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Sign in before starting cleanup.", href: "/connect" }, { status: 401, headers });
    // Old callers cannot implicitly choose a production provider or recovery action.
    if (!operation) {
      await requirePaidCleanupEntitlement(session.userId);
      return Response.json({ error: "Production cleanup is not available here.", code: "CLEANUP_UNAVAILABLE" }, { status: 503, headers });
    }
    await requireProductionCleanupAccess({ ...operation, userId: session.userId,
      providerConnectionId: session.providerConnectionId });
    return null;
  } catch (error) {
    if (error instanceof ProductionCleanupError) return Response.json({ error: error.message, code: error.code,
      href: "/app/account" }, { status: error.status, headers });
    return Response.json({
      error: error instanceof BillingError ? error.message : "Billing access could not be verified.",
      code: error instanceof EntitlementDeniedError ? "PAID_ACCESS_REQUIRED" : "BILLING_UNAVAILABLE",
      href: "/app/account", action: error instanceof EntitlementDeniedError ? error.action : "refresh"
    }, { status: error instanceof BillingError ? error.status : 503, headers });
  }
}
