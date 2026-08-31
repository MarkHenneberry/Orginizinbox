import type { GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";

export const gmailScalableWorkflowOperations = [
  "preflight_safety",
  "safety_check",
  "checkpoint_trash",
  "dispatch_trash",
  "verify_trash",
  "advance_chunk",
  "checkpoint_undo",
  "dispatch_undo",
  "verify_undo"
] as const;

export type GmailScalableWorkflowOperation = (typeof gmailScalableWorkflowOperations)[number];
export type GmailScalableWorkflowMode = "cleanup" | "undo";

export type GmailScalableWorkflowDecision =
  | { outcome: "run"; operation: GmailScalableWorkflowOperation }
  | { outcome: "sleep"; resumeAt: number }
  | { outcome: "stop"; reason: "complete" | "waiting_for_confirmation" | "terminal" | "missing_state" };

export function planGmailScalableWorkflowStep(
  job: GmailScalableStoredJob,
  mode: GmailScalableWorkflowMode,
  now = Date.now()
): GmailScalableWorkflowDecision {
  if (job.view.expiresAt <= now || job.view.status === "expired") return { outcome: "stop", reason: "terminal" };
  if (job.view.status === "paused") {
    const resumeAt = job.view.nextEligibleRunAt ?? now;
    if (resumeAt > now) return { outcome: "sleep", resumeAt };
    if (!job.payload.resumeState) return { outcome: "stop", reason: "terminal" };
    const resumed = structuredClone(job);
    resumed.view.status = job.payload.resumeState;
    resumed.view.nextEligibleRunAt = undefined;
    return planGmailScalableWorkflowStep(resumed, mode, now);
  }
  if (["failed", "partial", "uncertain", "undo_complete"].includes(job.view.status)) {
    return { outcome: "stop", reason: "terminal" };
  }

  if (mode === "undo") {
    if (job.view.status === "complete") return { outcome: "stop", reason: "waiting_for_confirmation" };
    if (job.view.status !== "undoing") return { outcome: "stop", reason: "terminal" };
    const chunk = job.payload.chunks.find(
      (candidate) => candidate.verifiedMovedIndexes.length > 0 && candidate.verifiedRestoredIndexes.length === 0
    );
    if (!chunk) return { outcome: "stop", reason: "complete" };
    if (chunk.undoMutationDispatched && !chunk.undoHistoryCheckpoint) return { outcome: "stop", reason: "terminal" };
    if (!chunk.undoHistoryCheckpoint) return { outcome: "run", operation: "checkpoint_undo" };
    return { outcome: "run", operation: chunk.undoMutationDispatched ? "verify_undo" : "dispatch_undo" };
  }

  if ((job.view.status === "created" || job.view.status === "safety_checking") && !job.payload.confirmedAt) {
    return { outcome: "run", operation: "preflight_safety" };
  }
  if (job.view.status === "safety_checking") {
    return { outcome: "run", operation: "safety_check" };
  }
  if (job.view.status === "ready") return { outcome: "stop", reason: "waiting_for_confirmation" };
  if (job.view.status === "mutating") {
    const chunk = job.payload.chunks.find((candidate) => job.view.chunks[candidate.index]?.status === "mutating");
    if (!chunk) return { outcome: "stop", reason: "terminal" };
    if (chunk.trashMutationDispatched && !chunk.historyCheckpoint) return { outcome: "stop", reason: "terminal" };
    if (!chunk.historyCheckpoint) return { outcome: "run", operation: "checkpoint_trash" };
    return { outcome: "run", operation: chunk.trashMutationDispatched ? "verify_trash" : "dispatch_trash" };
  }
  if (job.view.status === "verifying") return { outcome: "run", operation: "verify_trash" };
  if (job.view.status === "chunk_complete") return { outcome: "run", operation: "advance_chunk" };
  if (job.view.status === "complete") return { outcome: "stop", reason: "complete" };
  return { outcome: "stop", reason: "terminal" };
}

export function markGmailScalableMutationDispatch(
  job: GmailScalableStoredJob,
  operation: "dispatch_trash" | "dispatch_undo"
) {
  const next = structuredClone(job);
  if (operation === "dispatch_trash") {
    const chunk = next.payload.chunks.find((candidate) => next.view.chunks[candidate.index]?.status === "mutating");
    if (!chunk || chunk.trashMutationDispatched) return undefined;
    chunk.trashMutationDispatched = true;
    next.view.chunks[chunk.index].batchModifyRequests += 1;
  } else {
    const chunk = next.payload.chunks.find(
      (candidate) => candidate.verifiedMovedIndexes.length > 0 && candidate.verifiedRestoredIndexes.length === 0
    );
    if (!chunk || chunk.undoMutationDispatched) return undefined;
    chunk.undoMutationDispatched = true;
    next.view.chunks[chunk.index].undoMutationRequests += 1;
  }
  return next;
}
