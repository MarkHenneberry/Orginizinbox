import "server-only";
import type { GmailScalableJobView } from "@/lib/domain/gmail-scalable-cleanup";
import type { OutlookCleanupJobView } from "@/lib/domain/outlook-cleanup";
import type { GmailCleanupUiJob, OutlookCleanupUiJob } from "@/lib/domain/cleanup-ui";

export function gmailCleanupUiJob(job: GmailScalableJobView): GmailCleanupUiJob {
  return { id: job.id, status: job.status, requestedCount: job.requestedCount, safeCount: job.safeCount,
    excludedCount: job.excludedCount, attemptedCount: job.attemptedCount, verifiedCount: job.verifiedCount,
    failedCount: job.failedCount, uncertainCount: job.uncertainCount, verifiedRestoredCount: job.verifiedRestoredCount,
    failedRestoreCount: job.failedRestoreCount, uncertainRestoreCount: job.uncertainRestoreCount,
    verifiedProcessedCount: job.verifiedProcessedCount, suggestedDeltas: job.suggestedDeltas.map(({ groupIndex, verifiedMovedCount, verifiedRestoredCount }) => ({ groupIndex, verifiedMovedCount, verifiedRestoredCount })),
    groupIndices: job.groupIndices, chunkCount: job.chunkCount, chunksComplete: job.chunksComplete,
    chunks: job.chunks.map(({ index, status, startedAt }) => ({ index, status, startedAt })),
    undoAvailable: job.undoAvailable, restoreMode: job.restoreMode, recoveryRestoreAvailable: job.recoveryRestoreAvailable,
    recoveryRestoreCount: job.recoveryRestoreCount, createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt };
}

export function outlookCleanupUiJob(job: OutlookCleanupJobView): OutlookCleanupUiJob {
  return { provider: "microsoft", id: job.id, status: job.status, requested: job.requested, approved: job.approved,
    excludedBySafety: job.excludedBySafety, movedVerified: job.movedVerified, restoredVerified: job.restoredVerified,
    failed: job.failed, uncertain: job.uncertain, checked: job.checked, groupIndices: job.groupIndices,
    undoAvailable: job.undoAvailable, undoMode: job.undoMode, undoStatus: job.undoStatus, recoverableCount: job.recoverableCount,
    createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt,
    totalBatches: job.totalBatches, batchesCompleted: job.batchesCompleted,
    undoTotalBatches: job.undoTotalBatches, undoBatchesCompleted: job.undoBatchesCompleted };
}

// Explicit projection, not object spreading: no development diagnostics or mailbox state.
export function productionCleanupJobView(job: GmailScalableJobView | OutlookCleanupJobView) {
  const gmail = "requestedCount" in job;
  return {
    ui: gmail ? gmailCleanupUiJob(job) : outlookCleanupUiJob(job),
    id: job.id, provider: gmail ? "gmail" : "microsoft", status: job.status,
    requested: gmail ? job.requestedCount : job.requested,
    approved: gmail ? job.safeCount : job.approved,
    excludedBySafety: gmail ? job.excludedCount : job.excludedBySafety,
    movedVerified: gmail ? job.verifiedCount : job.movedVerified,
    restoredVerified: gmail ? job.verifiedRestoredCount : job.restoredVerified,
    failed: gmail ? job.failedCount : job.failed,
    uncertain: gmail ? job.uncertainCount : job.uncertain,
    failedRestore: gmail ? job.failedRestoreCount : undefined,
    uncertainRestore: gmail ? job.uncertainRestoreCount : undefined,
    undoAvailable: job.undoAvailable,
    undoMode: gmail ? job.restoreMode : job.undoMode,
    undoStatus: gmail ? undefined : job.undoStatus,
    updatedAt: job.updatedAt, expiresAt: job.expiresAt
  };
}
