export type CleanupSuggestedDelta = {
  groupIndex: number;
  verifiedMovedCount: number;
  verifiedRestoredCount: number;
};

export function mergeCleanupSuggestedDeltas(
  current: readonly CleanupSuggestedDelta[],
  updates: readonly { groupIndex: number; count: number }[],
  outcome: "moved" | "restored"
): CleanupSuggestedDelta[] {
  const merged = new Map(current.map((delta) => [delta.groupIndex, { ...delta }]));
  for (const update of updates) {
    if (!Number.isInteger(update.groupIndex) || update.groupIndex < 0 || !Number.isInteger(update.count) || update.count < 0) {
      throw new Error("Invalid cleanup Suggested-count adjustment.");
    }
    const delta = merged.get(update.groupIndex) ?? {
      groupIndex: update.groupIndex,
      verifiedMovedCount: 0,
      verifiedRestoredCount: 0
    };
    if (outcome === "moved") delta.verifiedMovedCount += update.count;
    else delta.verifiedRestoredCount = Math.min(
      delta.verifiedMovedCount,
      delta.verifiedRestoredCount + update.count
    );
    merged.set(update.groupIndex, delta);
  }
  return [...merged.values()].sort((left, right) => left.groupIndex - right.groupIndex);
}

export function getSessionAdjustedSuggestedCount(
  originalCount: number,
  delta: CleanupSuggestedDelta | undefined
) {
  return Math.max(0, originalCount - (delta?.verifiedMovedCount ?? 0) + (delta?.verifiedRestoredCount ?? 0));
}

export function getSessionAdjustedSuggestedTotal(
  groups: readonly { index: number; cleanupCandidateCount: number }[],
  deltas: readonly CleanupSuggestedDelta[]
) {
  const byGroup = new Map(deltas.map((delta) => [delta.groupIndex, delta]));
  return groups.reduce(
    (total, group) => total + getSessionAdjustedSuggestedCount(group.cleanupCandidateCount, byGroup.get(group.index)),
    0
  );
}
