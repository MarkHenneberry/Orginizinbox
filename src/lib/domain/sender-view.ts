import type { SenderAggregate } from "./types";

export type SenderSortKey = "emails" | "ready" | "unread" | "oldest" | "storage" | "recommendation";

export type SenderWorkspaceState = {
  search: string;
  sortKey: SenderSortKey;
  selectedSenderKey?: string;
};

export type SenderWorkspaceAction =
  | { type: "search"; search: string }
  | { type: "sort"; sortKey: SenderSortKey }
  | { type: "select"; senderKey: string };

const recommendationRank: Record<SenderAggregate["cleanupConfidence"], number> = {
  very_high: 4,
  high: 3,
  review: 2,
  keep: 1
};

export function filterAndSortSenders(
  senders: SenderAggregate[],
  search: string,
  sortKey: SenderSortKey
): SenderAggregate[] {
  const query = search.trim().toLocaleLowerCase("en-US");
  const filtered = query
    ? senders.filter((sender) =>
        [sender.displayName, sender.domain, sender.senderSecondaryLabel, sender.diagnosticSenderIdentity]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase("en-US").includes(query))
      )
    : [...senders];

  return filtered.sort((a, b) => compareSenders(a, b, sortKey) || a.displayName.localeCompare(b.displayName));
}

export function createSenderWorkspaceState(senders: SenderAggregate[]): SenderWorkspaceState {
  const sortKey: SenderSortKey = "emails";
  return {
    search: "",
    sortKey,
    selectedSenderKey: filterAndSortSenders(senders, "", sortKey)[0]?.senderKey
  };
}

export function reduceSenderWorkspaceState(
  senders: SenderAggregate[],
  state: SenderWorkspaceState,
  action: SenderWorkspaceAction
): SenderWorkspaceState {
  if (action.type === "select") {
    const visible = filterAndSortSenders(senders, state.search, state.sortKey);
    return visible.some((sender) => sender.senderKey === action.senderKey)
      ? { ...state, selectedSenderKey: action.senderKey }
      : state;
  }

  const next =
    action.type === "search"
      ? { ...state, search: action.search }
      : { ...state, sortKey: action.sortKey };
  const visible = filterAndSortSenders(senders, next.search, next.sortKey);
  const selectionStillVisible = visible.some((sender) => sender.senderKey === state.selectedSenderKey);

  return {
    ...next,
    selectedSenderKey: selectionStillVisible ? state.selectedSenderKey : visible[0]?.senderKey
  };
}

function compareSenders(a: SenderAggregate, b: SenderAggregate, sortKey: SenderSortKey) {
  if (sortKey === "ready") return b.cleanupCandidateCount - a.cleanupCandidateCount;
  if (sortKey === "unread") return b.unreadMessages - a.unreadMessages;
  if (sortKey === "oldest") return a.oldestMessageAt.getTime() - b.oldestMessageAt.getTime();
  if (sortKey === "storage") return b.estimatedEligibleBytes - a.estimatedEligibleBytes;
  if (sortKey === "recommendation") {
    return recommendationRank[b.cleanupConfidence] - recommendationRank[a.cleanupConfidence];
  }
  return b.totalMessages - a.totalMessages;
}
