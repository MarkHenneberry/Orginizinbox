import "server-only";
import type { ProviderConnection } from "@prisma/client";
import { prisma } from "@/lib/server/db";
import { runtimeConfig } from "@/lib/config";
import { assertProductionCleanupInfrastructure, type CleanupAccess } from "@/lib/server/production-cleanup";

export function stoppedProviderWork() {
  return new DOMException("Provider work no longer has durable authorization.", "AbortError");
}

export function createScanRequestFence(scanId: string, lockOwner: string, provider?: "gmail" | "microsoft") {
  return async () => {
    if (process.env.NODE_ENV === "production" && (!provider ||
        !(provider === "gmail" ? runtimeConfig.gmailAvailable : runtimeConfig.microsoftAvailable))) throw stoppedProviderWork();
    const now = new Date();
    // Refresh only the current live owner's lease, never revive expired or cancelled work.
    const updated = await prisma.scanState.updateMany({
      where: {
        scanId, lockOwner, status: "running",
        expiresAt: { gt: now }, lockExpiresAt: { gt: now },
        scan: { status: "running" },
        providerConnection: { disconnectedAt: null, encryptedAccessToken: { not: null } }
      },
      data: { lockExpiresAt: new Date(now.getTime() + 10 * 60 * 1000) }
    });
    if (updated.count !== 1) throw stoppedProviderWork();
  };
}

export function createCleanupRequestFence(
  connection: Pick<ProviderConnection, "id" | "userId" | "provider" | "sessionGeneration">,
  jobId: string,
  lockOwner?: string,
  version?: number,
  access: CleanupAccess = "forward"
) {
  return async () => {
    try { assertProductionCleanupInfrastructure(connection.provider, access); }
    catch { throw stoppedProviderWork(); }
    const now = new Date();
    const count = await prisma.cleanupJobState.count({
      where: {
        jobId, userId: connection.userId, expiresAt: { gt: now },
        lockExpiresAt: { gt: now },
        ...(lockOwner ? { lockOwner } : {}),
        ...(version !== undefined ? { version } : {}),
        job: {
          status: { not: "cancelled" },
          scan: {
            userId: connection.userId, provider: connection.provider, providerConnectionId: connection.id,
            providerConnection: {
              disconnectedAt: null, encryptedAccessToken: { not: null },
              sessionGeneration: connection.sessionGeneration
            }
          }
        }
      }
    });
    if (count !== 1) throw stoppedProviderWork();
  };
}
