import type { GmailScalableJobView, GmailScalableChunkView } from "@/lib/domain/gmail-scalable-cleanup";
import type { OutlookCleanupJobView } from "@/lib/domain/outlook-cleanup";

export type CleanupUiAccess = "available" | "upgrade" | "past_due" | "inactive" | "unavailable" | "reconnect";
export const cleanupAccessCopy: Record<CleanupUiAccess, { text: string; action?: string; href?: string }> = {
  available: { text: "Review your selection before moving any messages." },
  upgrade: { text: "Buy cleanup credits when you are ready. Your report is free.", action: "Buy credits", href: "/app/account" },
  past_due: { text: "Your payment needs attention before starting another cleanup.", action: "Manage billing", href: "/app/account" },
  inactive: { text: "Your credit account needs attention. Existing cleanup recovery is still available.", action: "View credits", href: "/app/account" },
  unavailable: { text: "New cleanup is temporarily unavailable. You can still check an existing cleanup or undo eligible moves." },
  reconnect: { text: "Connect your inbox from Account to continue.", action: "Open Account", href: "/app/account" }
};

export type GmailCleanupUiJob = Pick<GmailScalableJobView,
  "id" | "status" | "requestedCount" | "safeCount" | "excludedCount" | "attemptedCount" | "verifiedCount" |
  "failedCount" | "uncertainCount" | "verifiedRestoredCount" | "failedRestoreCount" | "uncertainRestoreCount" |
  "verifiedProcessedCount" | "suggestedDeltas" | "groupIndices" | "chunkCount" | "undoAvailable" | "restoreMode" |
  "recoveryRestoreAvailable" | "recoveryRestoreCount" | "createdAt" | "updatedAt" | "expiresAt" | "chunksComplete"
> & { chunks: Pick<GmailScalableChunkView, "index" | "status" | "startedAt">[] };
export type OutlookCleanupUiJob = Pick<OutlookCleanupJobView,
  "provider" | "id" | "status" | "requested" | "approved" | "excludedBySafety" | "movedVerified" | "restoredVerified" |
  "failed" | "uncertain" | "checked" | "groupIndices" | "undoAvailable" | "undoMode" | "undoStatus" |
  "recoverableCount" | "createdAt" | "updatedAt" | "expiresAt" |
  "totalBatches" | "batchesCompleted" | "undoTotalBatches" | "undoBatchesCompleted"
>;

export function isDevelopmentGmailJob(job: GmailCleanupUiJob): job is GmailScalableJobView {
  return "quotaConsumedUnits" in job;
}
export function isDevelopmentOutlookJob(job: OutlookCleanupUiJob): job is OutlookCleanupJobView {
  return "graphRequests" in job;
}

export function cleanupEndpoint(provider: "gmail" | "microsoft", action: string, development: boolean, scalable = true) {
  if (!development) return `/api/app/cleanup/${provider}/${action}`;
  return `/api/dev/${provider === "microsoft" ? "outlook-cleanup" : scalable ? "gmail-scalable-cleanup" : "gmail-cleanup"}/${action}`;
}
