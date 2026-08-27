import type { CleanupSenderGroup } from "@/lib/providers/gmail/cleanup-candidates";

export type CleanupSortKey = "ready" | "emails" | "unread" | "oldest" | "storage" | "recommendation";

export function eligibleCleanupGroupIndices(groups: CleanupSenderGroup[]) {
  return groups.filter((group) => group.eligible).map((group) => group.index);
}

export function createDefaultCleanupSelection(groups: CleanupSenderGroup[]) {
  return new Set(eligibleCleanupGroupIndices(groups));
}

export function updateCleanupSelection(
  current: ReadonlySet<number>,
  targetIndices: readonly number[],
  selected: boolean
) {
  const next = new Set(current);
  for (const index of targetIndices) {
    if (selected) next.add(index);
    else next.delete(index);
  }
  return next;
}

export function filterAndSortCleanupGroups(groups: CleanupSenderGroup[], search: string, sortKey: CleanupSortKey) {
  const query = search.trim().toLocaleLowerCase("en-US");
  return groups
    .filter(
      (group) =>
        !query ||
        `${group.displayName} ${group.secondaryLabel} ${group.searchableIdentity}`
          .toLocaleLowerCase("en-US")
          .includes(query)
    )
    .sort((first, second) => compareCleanupGroups(first, second, sortKey) || first.index - second.index);
}

function compareCleanupGroups(first: CleanupSenderGroup, second: CleanupSenderGroup, sortKey: CleanupSortKey) {
  if (sortKey === "emails") return second.totalMessages - first.totalMessages;
  if (sortKey === "unread") return second.unreadMessages - first.unreadMessages;
  if (sortKey === "oldest") return new Date(first.oldestMessageAt).getTime() - new Date(second.oldestMessageAt).getTime();
  if (sortKey === "storage") return second.estimatedEligibleBytes - first.estimatedEligibleBytes;
  if (sortKey === "recommendation") return recommendationRank(second) - recommendationRank(first);
  return second.cleanupCandidateCount - first.cleanupCandidateCount;
}

function recommendationRank(group: CleanupSenderGroup) {
  return { very_high: 4, high: 3, review: 2, keep: 1 }[group.cleanupConfidence];
}
