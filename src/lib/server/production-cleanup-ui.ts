import "server-only";
import { cache } from "react";
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

const presentationEntitlement = cache(getUserEntitlement);
export const getProductionCleanupUiState = cache(async (loadJob = false, freshSelection = false): Promise<CleanupUiState> => {
  const state: CleanupUiState = { access: "unavailable", hasJob: false };
  if (process.env.NODE_ENV !== "production") return state;
  try {
    const connection = await getCurrentProviderConnection();
    if (connection.mode !== "connected") return { ...state, access: connection.mode === "unavailable" ? "unavailable" : "reconnect" };
    state.provider = connection.provider;
    state.userId = connection.userId;
    assertProductionCleanupInfrastructure(connection.provider, "recovery");
    if (connection.provider === "microsoft") {
      const { getOutlookCleanupForPresentation, serializeOutlookCleanupJob } = await import("@/lib/server/outlook-cleanup-store");
      const job = await getOutlookCleanupForPresentation(connection.userId, connection.providerConnectionId, freshSelection);
      state.hasJob = Boolean(job);
      if (job && loadJob) {
        await requireProductionCleanupAccess({ userId: connection.userId, provider: connection.provider,
          providerConnectionId: connection.providerConnectionId, access: "recovery", jobId: job.view.id });
        state.jobScanId = job.payload.scanId;
        state.outlookJob = outlookCleanupUiJob(serializeOutlookCleanupJob(job));
      }
    } else {
      const row = await prisma.cleanupJobState.findFirst({ where: {
        userId: connection.userId, expiresAt: { gt: new Date() },
        job: { status: { not: "cancelled" }, scan: { provider: connection.provider, providerConnectionId: connection.providerConnectionId } }
      }, orderBy: { updatedAt: "desc" }, select: { jobId: true, job: { select: { scanId: true } } } });
      state.hasJob = Boolean(row);
      if (row && loadJob) {
        await requireProductionCleanupAccess({ userId: connection.userId, provider: connection.provider,
          providerConnectionId: connection.providerConnectionId, access: "recovery", jobId: row.jobId });
        state.jobScanId = row.job.scanId;
        const { getDurableGmailScalableCleanupStatus } = await import("@/lib/server/gmail-scalable-live-workflow");
        const job = await getDurableGmailScalableCleanupStatus(connection.userId, row.jobId);
        if (job) state.gmailJob = gmailCleanupUiJob(job);
      }
    }
    // Failure here must not discard an already loaded recovery view.
    try {
      assertProductionCleanupInfrastructure(connection.provider, "forward");
      const entitlement = await presentationEntitlement(connection.userId);
      state.access = entitlement.paidAccess ? "available" : entitlement.state === "free" ? "upgrade"
        : "inactive";
      // Presentation is not mutation authorization. Actual starts/confirms recheck on the server.
    } catch { state.access = "unavailable"; }
    return state;
  } catch { return { access: "unavailable", hasJob: false }; }
});
