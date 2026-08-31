import { describe, expect, it } from "vitest";
import {
  createGmailScalableChunkViews,
  getGmailScalableDiagnosticSnapshot,
  type GmailScalableJobView
} from "@/lib/domain/gmail-scalable-cleanup";
import {
  createGmailScalableTerminalSnapshot,
  terminalSnapshotToGmailScalableJobView
} from "@/lib/domain/gmail-scalable-terminal-snapshot";
import { resolveReportRecentCleanupAction } from "@/lib/domain/report-recent-action";

describe("scalable cleanup aggregate terminal state", () => {
  it("retains an aggregate-only UNDO_COMPLETE result without mailbox or sender mappings", () => {
    const view = terminalView();
    const diagnostic = getGmailScalableDiagnosticSnapshot(view);
    const snapshot = createGmailScalableTerminalSnapshot(view, diagnostic.content)!;
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("job-secret");
    expect(serialized).not.toMatch(/\"(?:groupIndex|apiMessageId|uidValidity|historyId|historyCheckpoint|subject|query)\":/i);

    const restored = terminalSnapshotToGmailScalableJobView({ id: "job-from-route", snapshot, snapshotVersion: 3 });
    expect(restored).toMatchObject({
      status: "undo_complete",
      chunksComplete: 2,
      verifiedCount: 477,
      verifiedRestoredCount: 477,
      terminalSnapshotVersion: 3,
      undoAvailable: false
    });
    expect(getGmailScalableDiagnosticSnapshot(restored).content).toBe(diagnostic.content);
  });

  it("keys copied diagnostics to the current READY, COMPLETE, UNDOING, and UNDO_COMPLETE content", () => {
    const ready = terminalView({ status: "ready", completedAt: undefined, verifiedCount: 0, verifiedRestoredCount: 0 });
    const complete = terminalView({ status: "complete", verifiedRestoredCount: 0 });
    const undoing = terminalView({ status: "undoing", completedAt: undefined, verifiedRestoredCount: 0 });
    const undoComplete = terminalView();
    const keys = [ready, complete, undoing, undoComplete].map((job) => getGmailScalableDiagnosticSnapshot(job).key);
    expect(new Set(keys).size).toBe(4);
    expect(getGmailScalableDiagnosticSnapshot(undoComplete).content).toContain("Job result: UNDO_COMPLETE");
  });

  it("acknowledges full Undo without adjusting the original report and distinguishes a newer report", () => {
    const snapshot = createGmailScalableTerminalSnapshot(terminalView(), "safe diagnostic")!;
    expect(resolveReportRecentCleanupAction({
      snapshot,
      cleanupScanId: "scan-before-cleanup",
      activeScanId: "scan-before-cleanup",
      activeScanCompletedAt: snapshot.completedAt - 1
    })).toMatchObject({ outcome: "undo_complete", reportRelation: "original_report", verifiedRestoredCount: 477 });
    expect(resolveReportRecentCleanupAction({
      snapshot,
      cleanupScanId: "scan-before-cleanup",
      activeScanId: "scan-after-cleanup",
      activeScanCompletedAt: snapshot.completedAt - 1
    })).toMatchObject({ outcome: "undo_complete", reportRelation: "report_after_cleanup" });
    expect(resolveReportRecentCleanupAction({
      snapshot,
      cleanupScanId: "scan-before-cleanup",
      activeScanId: "scan-after-undo",
      activeScanCompletedAt: snapshot.completedAt + 1
    })).toBeUndefined();
  });

  it("reports only verified restoration for a partial Undo", () => {
    const partialView = terminalView({
      status: "partial",
      verifiedRestoredCount: 470,
      failedRestoreCount: 2,
      uncertainRestoreCount: 5
    });
    const snapshot = createGmailScalableTerminalSnapshot(partialView, "safe partial diagnostic")!;
    expect(resolveReportRecentCleanupAction({
      snapshot,
      cleanupScanId: "scan-a",
      activeScanId: "scan-a",
      activeScanCompletedAt: snapshot.completedAt - 1
    })).toEqual({
      outcome: "restore_partial",
      reportRelation: "original_report",
      verifiedRestoredCount: 470,
      failedRestoreCount: 2,
      uncertainRestoreCount: 5
    });
  });
});

function terminalView(overrides: Partial<GmailScalableJobView> = {}): GmailScalableJobView {
  const chunks = createGmailScalableChunkViews(500).map((chunk) => ({
    ...chunk,
    status: "undo_complete" as const,
    safeCount: chunk.index === 0 ? 240 : 237,
    excludedCount: chunk.index === 0 ? 10 : 13,
    attemptedCount: chunk.index === 0 ? 240 : 237,
    verifiedCount: chunk.index === 0 ? 240 : 237,
    verifiedRestoredCount: chunk.index === 0 ? 240 : 237
  }));
  return {
    id: "job-secret",
    status: "undo_complete",
    requestedCount: 500,
    chunkSize: 250,
    chunkCount: 2,
    chunksComplete: 2,
    safeCount: 477,
    excludedCount: 23,
    attemptedCount: 477,
    verifiedCount: 477,
    failedCount: 0,
    uncertainCount: 0,
    verifiedRestoredCount: 477,
    failedRestoreCount: 0,
    uncertainRestoreCount: 0,
    verifiedProcessedCount: 477,
    progressLabel: "477 messages restored.",
    quotaConsumedUnits: 242,
    developmentAuditQuotaUnits: 0,
    quotaWorkingLimit: 4_500,
    suggestedDeltas: [{ groupIndex: 9, verifiedMovedCount: 477, verifiedRestoredCount: 477 }],
    groupIndices: [9],
    chunks,
    undoAvailable: false,
    restoreMode: "undo",
    duplicateStartCount: 0,
    duplicateDispatchCount: 0,
    duplicateUndoCount: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    expiresAt: 3_000,
    completedAt: 2_000,
    ...overrides
  };
}
