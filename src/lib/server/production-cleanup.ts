import "server-only";
import { runtimeConfig } from "@/lib/config";
import { prisma } from "@/lib/server/db";
import { resolveProductionProviders } from "@/lib/server/production-config";
import { hasRequiredGmailImapScope } from "@/lib/providers/gmail/scopes";
import { hasRequiredMicrosoftMailScope } from "@/lib/providers/microsoft/scopes";
import { requirePaidCleanupEntitlement } from "@/lib/billing/entitlements";

export type CleanupProvider = "gmail" | "microsoft";
export type CleanupAccess = "forward" | "recovery";

export function resolveProductionCleanup(input: Record<string, string | undefined>) {
  const providers = resolveProductionProviders(input);
  const workflow = input.CLEANUP_WORKFLOW_ENABLED === "true";
  return {
    gmail: { recovery: providers.gmail && workflow,
      forward: providers.gmail && workflow && input.GMAIL_PRODUCTION_CLEANUP_ENABLED === "true" },
    microsoft: { recovery: providers.microsoft && workflow,
      forward: providers.microsoft && workflow && input.MICROSOFT_PRODUCTION_CLEANUP_ENABLED === "true" }
  };
}

export class ProductionCleanupError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export function assertProductionCleanupInfrastructure(provider: CleanupProvider, access: CleanupAccess) {
  if (process.env.NODE_ENV !== "production") return;
  const available = provider === "gmail" ? runtimeConfig.gmailAvailable : runtimeConfig.microsoftAvailable;
  if (!available || runtimeConfig.gmailScalableStoreAdapter !== "prisma" ||
      !resolveProductionCleanup(process.env)[provider][access]) {
    throw new ProductionCleanupError(access === "forward" ? "Cleanup is temporarily unavailable."
      : "Recovery is temporarily unavailable. Keep your inbox connected and try again shortly.", 503, "CLEANUP_UNAVAILABLE");
  }
}

// Called with server-authenticated identity, never user/provider IDs from a body.
// Recovery deliberately does not depend on Stripe or the forward rollout switch.
export async function requireProductionCleanupAccess(input: {
  userId: string; provider: CleanupProvider; providerConnectionId?: string;
  access: CleanupAccess; jobId?: string;
}) {
  if (process.env.NODE_ENV !== "production") return;
  assertProductionCleanupInfrastructure(input.provider, input.access);
  if (input.access === "forward") await requirePaidCleanupEntitlement(input.userId, input.jobId);
  const connection = await prisma.providerConnection.findFirst({ where: {
    id: input.providerConnectionId, userId: input.userId, provider: input.provider, disconnectedAt: null
  } });
  const scopeValid = input.provider === "gmail" ? hasRequiredGmailImapScope(connection?.scope ?? undefined)
    : hasRequiredMicrosoftMailScope(connection?.scope);
  if (!connection?.encryptedAccessToken || !connection.encryptedRefreshToken || !scopeValid ||
      (input.provider === "gmail" && !connection.encryptedAccountEmail)) {
    throw new ProductionCleanupError("Reconnect your inbox from Account before continuing.", 401, "CONNECTION_REQUIRED");
  }
  if (input.access === "recovery" && !input.jobId) {
    throw new ProductionCleanupError("An existing cleanup job is required.", 400, "JOB_REQUIRED");
  }
  if (input.jobId) {
    const owned = await prisma.cleanupJobState.count({ where: {
      jobId: input.jobId, userId: input.userId, expiresAt: { gt: new Date() },
      job: { status: { not: "cancelled" }, scan: {
        userId: input.userId, provider: input.provider, providerConnectionId: connection.id
      } }
    } });
    if (owned !== 1) throw new ProductionCleanupError("Cleanup recovery state is unavailable or expired.", 410, "JOB_UNAVAILABLE");
  }
}
