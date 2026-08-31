import "server-only";
import {
  resolveReportRecentCleanupAction,
  type ReportRecentCleanupAction
} from "@/lib/domain/report-recent-action";
import { parseGmailScalableTerminalSnapshot } from "@/lib/domain/gmail-scalable-terminal-snapshot";
import { prisma } from "@/lib/server/db";

export async function getLatestGmailScalableUndoReportContext(input: {
  userId: string;
  activeScanId: string;
  activeScanCompletedAt?: number;
}): Promise<ReportRecentCleanupAction | undefined> {
  const row = await prisma.cleanupJob.findFirst({
    where: {
      scan: { userId: input.userId },
      terminalState: { in: ["undo_complete", "partial", "uncertain"] }
    },
    orderBy: { updatedAt: "desc" },
    select: { scanId: true, terminalSnapshot: true }
  });
  if (!row) return undefined;
  const snapshot = parseGmailScalableTerminalSnapshot(row.terminalSnapshot);
  if (!snapshot) return undefined;
  return resolveReportRecentCleanupAction({
    snapshot,
    cleanupScanId: row.scanId,
    activeScanId: input.activeScanId,
    activeScanCompletedAt: input.activeScanCompletedAt
  });
}
