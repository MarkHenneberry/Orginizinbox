import type { GmailScalableTerminalSnapshot } from "@/lib/domain/gmail-scalable-terminal-snapshot";

export type ReportRecentCleanupAction = {
  outcome: "undo_complete" | "restore_partial";
  reportRelation: "original_report" | "report_after_cleanup";
  verifiedRestoredCount: number;
  failedRestoreCount: number;
  uncertainRestoreCount: number;
};

export function resolveReportRecentCleanupAction(input: {
  snapshot: GmailScalableTerminalSnapshot;
  cleanupScanId: string;
  activeScanId: string;
  activeScanCompletedAt?: number;
}): ReportRecentCleanupAction | undefined {
  const { snapshot } = input;
  if (!snapshot.restoreMode) return undefined;
  if (input.activeScanCompletedAt && snapshot.completedAt <= input.activeScanCompletedAt) return undefined;
  const fullUndo = snapshot.status === "undo_complete" &&
    snapshot.restoreMode === "undo" &&
    snapshot.verifiedRestoredCount === snapshot.verifiedCount &&
    snapshot.failedRestoreCount === 0 &&
    snapshot.uncertainRestoreCount === 0;
  return {
    outcome: fullUndo ? "undo_complete" : "restore_partial",
    reportRelation: input.cleanupScanId === input.activeScanId ? "original_report" : "report_after_cleanup",
    verifiedRestoredCount: snapshot.verifiedRestoredCount,
    failedRestoreCount: snapshot.failedRestoreCount,
    uncertainRestoreCount: snapshot.uncertainRestoreCount
  };
}
