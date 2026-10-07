export type PermanentDeleteTargetState = "pending" | "dispatching" | "verified_deleted" | "excluded" | "uncertain";
export type PermanentDeleteState = {
  status: "running" | "complete" | "uncertain";
  targets: Array<{ key: string; messageId: string; folderId?: string; state: PermanentDeleteTargetState }>;
};
export type PermanentDeleteView = { status: "available" | "unavailable" | PermanentDeleteState["status"]; eligible: number;
  requested: number; verifiedDeleted: number; excluded: number; uncertain: number; undoRemaining?: number };

export function blockedByPermanentDelete(state: PermanentDeleteState | undefined, key: string) {
  return state?.status === "running" || Boolean(state?.targets.some(target => target.key === key && target.state !== "pending"));
}

export function restorableGmailIndexes(job: { permanentDeletion?: PermanentDeleteState }, chunk: {
  index: number; verifiedMovedIndexes: number[]; verifiedRestoredIndexes: number[];
}) {
  return chunk.verifiedMovedIndexes.filter(index => !chunk.verifiedRestoredIndexes.includes(index) &&
    !blockedByPermanentDelete(job.permanentDeletion, `${chunk.index}:${index}`));
}

export function permanentDeleteView(state: PermanentDeleteState | undefined, eligible: number): PermanentDeleteView {
  return { status: state?.status ?? (eligible ? "available" : "unavailable"), eligible,
    requested: state?.targets.length ?? eligible,
    verifiedDeleted: state?.targets.filter(t => t.state === "verified_deleted").length ?? 0,
    excluded: state?.targets.filter(t => t.state === "excluded").length ?? 0,
    uncertain: state?.targets.filter(t => t.state === "uncertain" || t.state === "dispatching").length ?? 0 };
}
