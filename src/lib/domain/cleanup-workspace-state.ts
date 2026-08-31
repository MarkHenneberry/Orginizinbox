import type {
  GmailCleanupJobStatus,
  GmailCleanupOperationStates
} from "@/lib/domain/gmail-cleanup-summary";

export type CleanupWorkspaceOperation =
  | "resolution"
  | "benchmark"
  | "trash"
  | "undo"
  | "bulk_undo_proof"
  | "rescan"
  | "start_over";

export type CleanupWorkspaceState =
  | "select"
  | "review"
  | "moving"
  | "verifying"
  | "complete"
  | "undoing"
  | "undo_complete"
  | "expired";

export function getCleanupWorkspaceState(input: {
  reviewStarted: boolean;
  snapshotExpired: boolean;
  activeOperation: CleanupWorkspaceOperation | null;
  jobStatus?: GmailCleanupJobStatus;
  mutationStarted?: boolean;
  operationStates?: GmailCleanupOperationStates;
}) {
  if (!input.reviewStarted) return workspaceState("select", false);
  if (input.snapshotExpired) return workspaceState("expired", false);
  if (input.activeOperation === "undo" || input.jobStatus === "undoing") {
    return workspaceState("undoing", true);
  }
  if (
    input.jobStatus === "undone" ||
    input.jobStatus === "undo_partial" ||
    input.jobStatus === "undo_failed"
  ) {
    return workspaceState("undo_complete", true);
  }
  const cleanupComplete =
    input.jobStatus === "completed" ||
    input.jobStatus === "partial" ||
    (input.jobStatus === "failed" && input.mutationStarted === true);
  if (cleanupComplete) return workspaceState("complete", true);
  if (input.activeOperation === "trash" || input.jobStatus === "running") {
    return workspaceState(
      input.operationStates?.trashVerification === "in_progress" ? "verifying" : "moving",
      false
    );
  }
  return workspaceState("review", false);
}

function workspaceState(state: CleanupWorkspaceState, sessionAdjusted: boolean) {
  return {
    state,
    showFrozenSenderContext: state !== "select",
    sessionAdjusted
  };
}
