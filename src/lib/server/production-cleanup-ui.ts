import "server-only";
import { prisma } from "@/lib/server/db";
import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";
import { getUserEntitlement } from "@/lib/billing/entitlements";
import { assertProductionCleanupInfrastructure, requireProductionCleanupAccess } from "@/lib/server/production-cleanup";
import { gmailCleanupUiJob, outlookCleanupUiJob } from "@/lib/server/production-cleanup-response";
import type { CleanupUiAccess, GmailCleanupUiJob, OutlookCleanupUiJob } from "@/lib/domain/cleanup-ui";

type CleanupUiState = {
  access: CleanupUiAccess; provider?: "gmail" | "microsoft"; hasJob: boolean;
  userId?: string; jobScanId?: string; gmailJob?: GmailCleanupUiJob; outlookJob?: OutlookCleanupUiJob;
};

export async function getProductionCleanupUiState(loadJob = false): Promise<CleanupUiState> {
  const state: CleanupUiState = { access: "unavailable", hasJob: false };
  if (process.env.NODE_ENV !== "production") return state;
  try {
    const connection = await getCurrentProviderConnection();
    if (connection.mode !== "connected") return { ...state, access: connection.mode === "unavailable" ? "unavailable" : "reconnect" };
    state.provider = connection.provider;
    state.userId = connection.userId;
    assertProductionCleanupInfrastructure(connection.provider, "recovery");
    const row = await prisma.cleanupJobState.findFirst({ where: {
      userId: connection.userId, expiresAt: { gt: new Date() },
      job: { status: { not: "cancelled" }, scan: { provider: connection.provider, providerConnectionId: connection.providerConnectionId } }
    }, orderBy: { updatedAt: "desc" }, select: { jobId: true, job: { select: { scanId: true } } } });
    state.hasJob = Boolean(row);
    if (row && loadJob) {
      await requireProductionCleanupAccess({ userId: connection.userId, provider: connection.provider,
        providerConnectionId: connection.providerConnectionId, access: "recovery", jobId: row.jobId });
      state.jobScanId = row.job.scanId;
      if (connection.provider === "gmail") {
        const { getDurableGmailScalableCleanupStatus } = await import("@/lib/server/gmail-scalable-live-workflow");
        const job = await getDurableGmailScalableCleanupStatus(connection.userId, row.jobId);
        if (job) state.gmailJob = gmailCleanupUiJob(job);
      } else {
        const { createPrismaOutlookCleanupStore, serializeOutlookCleanupJob } = await import("@/lib/server/outlook-cleanup-store");
        const job = await createPrismaOutlookCleanupStore().get(connection.userId, row.jobId);
        if (job?.provider === "microsoft") state.outlookJob = outlookCleanupUiJob(serializeOutlookCleanupJob(job));
      }
    }
    // Failure here must not discard an already loaded recovery view.
    try {
      assertProductionCleanupInfrastructure(connection.provider, "forward");
      const entitlement = await getUserEntitlement(connection.userId);
      state.access = entitlement.paidAccess ? "available" : entitlement.state === "free" ? "upgrade"
        : "inactive";
      if (state.access === "available") await requireProductionCleanupAccess({ userId: connection.userId,
        provider: connection.provider, providerConnectionId: connection.providerConnectionId, access: "forward" });
    } catch { state.access = "unavailable"; }
    return state;
  } catch { return { access: "unavailable", hasJob: false }; }
}
