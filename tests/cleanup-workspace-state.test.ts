import { describe, expect, it } from "vitest";
import { getSessionAdjustedSuggestedCount } from "@/lib/domain/cleanup-session-adjustments";
import { getCleanupWorkspaceState } from "@/lib/domain/cleanup-workspace-state";

const operationStates = {
  resolution: "completed",
  trashMutation: "not_started",
  trashVerification: "not_started",
  undo: "not_started"
} as const;

describe("persistent cleanup workspace visual states", () => {
  it("keeps frozen sender context from REVIEW through every operation and result state", () => {
    const states = [
      getCleanupWorkspaceState({ reviewStarted: true, snapshotExpired: false, activeOperation: null, jobStatus: "ready", operationStates }),
      getCleanupWorkspaceState({ reviewStarted: true, snapshotExpired: false, activeOperation: "trash", jobStatus: "ready", operationStates }),
      getCleanupWorkspaceState({
        reviewStarted: true,
        snapshotExpired: false,
        activeOperation: "trash",
        jobStatus: "running",
        operationStates: { ...operationStates, trashVerification: "in_progress" }
      }),
      getCleanupWorkspaceState({ reviewStarted: true, snapshotExpired: false, activeOperation: null, jobStatus: "completed", operationStates }),
      getCleanupWorkspaceState({ reviewStarted: true, snapshotExpired: false, activeOperation: "undo", jobStatus: "completed", operationStates }),
      getCleanupWorkspaceState({ reviewStarted: true, snapshotExpired: false, activeOperation: null, jobStatus: "undone", operationStates }),
      getCleanupWorkspaceState({ reviewStarted: true, snapshotExpired: true, activeOperation: null, jobStatus: "ready", operationStates })
    ];
    expect(states.map((state) => state.state)).toEqual([
      "review",
      "moving",
      "verifying",
      "complete",
      "undoing",
      "undo_complete",
      "expired"
    ]);
    expect(states.every((state) => state.showFrozenSenderContext)).toBe(true);
  });

  it("keeps pre-cleanup counts while moving or verifying, then applies verified deltas", () => {
    const moving = getCleanupWorkspaceState({
      reviewStarted: true,
      snapshotExpired: false,
      activeOperation: "trash",
      jobStatus: "ready",
      operationStates
    });
    const verifying = getCleanupWorkspaceState({
      reviewStarted: true,
      snapshotExpired: false,
      activeOperation: "trash",
      jobStatus: "running",
      operationStates: { ...operationStates, trashMutation: "completed", trashVerification: "in_progress" }
    });
    const complete = getCleanupWorkspaceState({
      reviewStarted: true,
      snapshotExpired: false,
      activeOperation: null,
      jobStatus: "partial",
      operationStates
    });
    const delta = { groupIndex: 1, verifiedMovedCount: 23, verifiedRestoredCount: 0 };
    const displayed = (sessionAdjusted: boolean) =>
      sessionAdjusted ? getSessionAdjustedSuggestedCount(835, delta) : 835;

    expect(displayed(moving.sessionAdjusted)).toBe(835);
    expect(displayed(verifying.sessionAdjusted)).toBe(835);
    expect(displayed(complete.sessionAdjusted)).toBe(812);
  });

  it("keeps post-cleanup counts through Undo and increments only after verified restoration", () => {
    const undoing = getCleanupWorkspaceState({
      reviewStarted: true,
      snapshotExpired: false,
      activeOperation: "undo",
      jobStatus: "completed",
      operationStates
    });
    const undoComplete = getCleanupWorkspaceState({
      reviewStarted: true,
      snapshotExpired: false,
      activeOperation: null,
      jobStatus: "undo_partial",
      operationStates
    });
    expect(undoing.sessionAdjusted).toBe(true);
    expect(getSessionAdjustedSuggestedCount(835, {
      groupIndex: 1,
      verifiedMovedCount: 25,
      verifiedRestoredCount: 0
    })).toBe(810);
    expect(undoComplete.sessionAdjusted).toBe(true);
    expect(getSessionAdjustedSuggestedCount(835, {
      groupIndex: 1,
      verifiedMovedCount: 25,
      verifiedRestoredCount: 24
    })).toBe(834);
  });

  it("uses the interactive workspace only in SELECT", () => {
    expect(getCleanupWorkspaceState({
      reviewStarted: false,
      snapshotExpired: false,
      activeOperation: null
    })).toEqual({ state: "select", showFrozenSenderContext: false, sessionAdjusted: false });
  });
});
