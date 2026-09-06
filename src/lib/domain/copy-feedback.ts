export const COPY_FEEDBACK_DURATION_MS = 1600;

export type CopyFeedbackState = {
  snapshotKey: string;
  status: "idle" | "copied" | "failed";
};

export type CopyFeedbackAction =
  | { type: "snapshot_changed"; snapshotKey: string }
  | { type: "copy_succeeded"; snapshotKey: string }
  | { type: "copy_failed"; snapshotKey: string }
  | { type: "reset"; snapshotKey: string };

export function reduceCopyFeedback(
  state: CopyFeedbackState,
  action: CopyFeedbackAction
): CopyFeedbackState {
  if (action.type === "snapshot_changed") {
    return action.snapshotKey === state.snapshotKey
      ? state
      : { snapshotKey: action.snapshotKey, status: "idle" };
  }
  if (action.snapshotKey !== state.snapshotKey) return state;
  if (action.type === "copy_succeeded") return { ...state, status: "copied" };
  if (action.type === "copy_failed") return { ...state, status: "failed" };
  return { ...state, status: "idle" };
}

export function copyFeedbackLabel(
  state: CopyFeedbackState,
  currentSnapshotKey: string,
  idleLabel: string
) {
  if (state.snapshotKey !== currentSnapshotKey || state.status === "idle") return idleLabel;
  return state.status === "copied" ? "Copied" : "Copy failed";
}
