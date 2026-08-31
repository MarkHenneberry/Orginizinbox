import "server-only";
import type { GmailStateVerificationResult } from "@/lib/providers/gmail/gmail-api-client";
import type { GmailCleanupStoredCandidate } from "@/lib/server/gmail-cleanup-store";

export function countVerifiedCandidatesByGroup(
  candidates: readonly GmailCleanupStoredCandidate[],
  verifiedIds: readonly string[]
) {
  const verified = new Set(verifiedIds);
  const counts = new Map<number, number>();
  for (const candidate of candidates) {
    if (!verified.has(candidate.apiMessageId)) continue;
    counts.set(candidate.groupIndex, (counts.get(candidate.groupIndex) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([groupIndex, count]) => ({ groupIndex, count }))
    .sort((left, right) => left.groupIndex - right.groupIndex);
}

export function createBulkUndoRecoveryPlan(currentState: GmailStateVerificationResult) {
  return {
    recoveryIds: [...currentState.verifiedIds],
    alreadyRestoredIds: [...currentState.failedIds],
    uncertainCount: currentState.uncertainCount
  };
}
