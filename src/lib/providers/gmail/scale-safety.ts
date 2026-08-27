import { normalizeGmailLabel } from "@/lib/domain/gmail-labels";
import { gmailImapDecimalIdToApiHex } from "@/lib/providers/gmail/id-bridge";

export type GmailMutableState = {
  starred: boolean;
  important: boolean;
  trash: boolean;
  sent: boolean;
  draft: boolean;
  personal: boolean;
};

export type GmailImapScaleTarget = {
  uid: number;
  apiMessageId: string;
};

export type GmailImapRecheckMessage = {
  uid: number;
  emailId?: string;
  flags?: ReadonlySet<string>;
  labels?: readonly string[];
};

export type GmailExactImapRecheckResult = {
  eligibleIds: string[];
  excludedMissingCount: number;
  excludedIdentityMismatchCount: number;
  statesById: Map<string, GmailMutableState>;
};

export type GmailListPage = {
  ids: string[];
  nextPageToken?: string;
};

export type GmailPaginationMetrics = {
  requests: number;
  pages: number;
  resultIdsReturned: number;
  ids: Set<string>;
};

export function assertMatchingUidValidity(expected: bigint, actual: bigint) {
  if (expected !== actual) throw new Error("Gmail UIDVALIDITY changed; exact IMAP recheck is unavailable.");
}

export function evaluateExactImapRecheck(
  targets: readonly GmailImapScaleTarget[],
  messages: readonly GmailImapRecheckMessage[]
): GmailExactImapRecheckResult {
  const targetsByUid = new Map(targets.map((target) => [target.uid, target]));
  const seenUids = new Set<number>();
  const eligibleIds: string[] = [];
  const statesById = new Map<string, GmailMutableState>();
  let excludedIdentityMismatchCount = 0;

  for (const message of messages) {
    const target = targetsByUid.get(message.uid);
    if (!target || seenUids.has(message.uid)) continue;
    seenUids.add(message.uid);
    if (!message.emailId || gmailImapDecimalIdToApiHex(message.emailId) !== target.apiMessageId.toLowerCase()) {
      excludedIdentityMismatchCount += 1;
      continue;
    }
    const state = mutableStateFromImap(message.flags ?? new Set(), message.labels ?? []);
    statesById.set(target.apiMessageId, state);
    if (!state.starred && !state.important && !state.trash && !state.sent && !state.draft) {
      eligibleIds.push(target.apiMessageId);
    }
  }

  return {
    eligibleIds,
    excludedMissingCount: targets.length - seenUids.size,
    excludedIdentityMismatchCount,
    statesById
  };
}

export function mutableStateFromImap(flags: ReadonlySet<string>, labels: readonly string[]): GmailMutableState {
  const normalizedFlags = new Set([...flags].map((flag) => flag.trim().toUpperCase()));
  const normalizedLabels = new Set(labels.map(normalizeGmailLabel));
  return {
    starred: normalizedFlags.has("\\FLAGGED") || normalizedLabels.has("STARRED") || normalizedLabels.has("FLAGGED"),
    important: normalizedLabels.has("IMPORTANT"),
    trash: normalizedLabels.has("TRASH"),
    sent: normalizedLabels.has("SENT"),
    draft: normalizedFlags.has("\\DRAFT") || normalizedLabels.has("DRAFT"),
    personal: false
  };
}

export function mutableStateFromRest(labelIds: readonly string[]): GmailMutableState {
  const labels = new Set(labelIds.map((label) => label.toUpperCase()));
  return {
    starred: labels.has("STARRED"),
    important: labels.has("IMPORTANT"),
    trash: labels.has("TRASH"),
    sent: labels.has("SENT"),
    draft: labels.has("DRAFT"),
    personal: labels.has("CATEGORY_PERSONAL") || labels.has("CATEGORY_PRIMARY")
  };
}

export function compareImapAndRestMutableState(
  imapStates: ReadonlyMap<string, GmailMutableState>,
  restStates: ReadonlyMap<string, GmailMutableState>,
  ids: readonly string[]
) {
  let stateMatches = 0;
  let mismatches = 0;
  let unavailable = 0;
  for (const id of ids) {
    const imap = imapStates.get(id);
    const rest = restStates.get(id);
    if (!imap || !rest) {
      unavailable += 1;
      continue;
    }
    const matches = (["starred", "important", "trash", "sent", "draft"] as const).every(
      (key) => imap[key] === rest[key]
    );
    if (matches) stateMatches += 1;
    else mismatches += 1;
  }
  return { compared: ids.length, stateMatches, mismatches, unavailable };
}

export async function collectCompleteGmailList(
  fetchPage: (pageToken?: string) => Promise<GmailListPage>
): Promise<GmailPaginationMetrics> {
  const ids = new Set<string>();
  const seenPageTokens = new Set<string>();
  let requests = 0;
  let pages = 0;
  let resultIdsReturned = 0;
  let pageToken: string | undefined;

  do {
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) throw new Error("Gmail list pagination repeated a page token.");
      seenPageTokens.add(pageToken);
    }
    const page = await fetchPage(pageToken);
    requests += 1;
    pages += 1;
    resultIdsReturned += page.ids.length;
    page.ids.forEach((id) => ids.add(id));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return { requests, pages, resultIdsReturned, ids };
}

export function intersectCount(targetIds: readonly string[], resultIds: ReadonlySet<string>) {
  return targetIds.reduce((count, id) => count + (resultIds.has(id) ? 1 : 0), 0);
}
