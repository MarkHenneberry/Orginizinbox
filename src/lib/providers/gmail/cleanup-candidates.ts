import type { SenderAggregate } from "@/lib/domain/types";
import { deriveSubjectProtection } from "@/lib/domain/subject-protection";
import { parseSender } from "@/lib/providers/gmail/metadata";

export const gmailCleanupAgeThresholdLabel = "older than six months";
const cleanupAgeThresholdMs = 180 * 24 * 60 * 60 * 1000;

export type GmailCleanupCandidate = {
  apiMessageId: string;
  requiresMutableStrongEvidenceRecheck: boolean;
};

export type GmailMinimalMessageMetadata = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  sizeEstimate?: number;
  headers?: Array<{ name: string; value: string }>;
};

export type GmailMutationSafetyContext = {
  expectedSenderAddress: string;
  participatedConversationIds: ReadonlySet<string>;
  protectedSenders?: ReadonlySet<string>;
  now?: Date;
};

export const gmailCleanupExclusionReasons = [
  "STARRED",
  "IMPORTANT",
  "RECENT",
  "SENT",
  "DRAFT",
  "PERSONAL_CATEGORY",
  "PROTECTED_SUBJECT",
  "PARTICIPATED_CONVERSATION",
  "STRONG_EVIDENCE_MISSING",
  "SENDER_MISMATCH",
  "ALREADY_TRASH",
  "PROTECTED_SENDER",
  "OTHER"
] as const;

export type GmailCleanupExclusionReason = (typeof gmailCleanupExclusionReasons)[number];
export type GmailCleanupExclusionCounts = Record<GmailCleanupExclusionReason, number>;

export type GmailCandidateSafetyAssessment = {
  eligible: boolean;
  exclusionReasons: GmailCleanupExclusionReason[];
  hasStableStrongCleanupEvidence: boolean;
  reliesOnMutableCategoryEvidence: boolean;
};

export type CleanupSenderGroup = {
  index: number;
  displayName: string;
  secondaryLabel: string;
  searchableIdentity: string;
  totalMessages: number;
  unreadMessages: number;
  oldMessages: number;
  oldestMessageAt: Date;
  estimatedEligibleBytes: number;
  protectedMessages: number;
  reviewMessages: number;
  cleanupCandidateCount: number;
  cleanupConfidence: SenderAggregate["cleanupConfidence"];
  eligible: boolean;
  ineligibleReason?: "REVIEW_GROUP" | "KEEP_GROUP" | "NO_READY_MESSAGES" | "PROTECTED_SENDER";
};

export function buildCleanupSenderGroups(senders: SenderAggregate[]): CleanupSenderGroup[] {
  return senders.map((sender, index) => {
    const ineligibleReason = getCleanupGroupIneligibleReason(sender);
    return {
      index,
      displayName: sender.displayName,
      secondaryLabel: sender.senderSecondaryLabel ?? sender.domain ?? "Sender group",
      searchableIdentity: sender.senderSecondaryLabel ?? sender.domain ?? "",
      totalMessages: sender.totalMessages,
      unreadMessages: sender.unreadMessages,
      oldMessages: sender.oldMessages,
      oldestMessageAt: sender.oldestMessageAt,
      estimatedEligibleBytes: sender.estimatedEligibleBytes,
      protectedMessages: sender.protectedMessages,
      reviewMessages: sender.reviewMessages,
      cleanupCandidateCount: sender.cleanupCandidateCount,
      cleanupConfidence: sender.cleanupConfidence,
      eligible: !ineligibleReason,
      ineligibleReason
    };
  });
}

export function allocateCleanupCountAcrossGroups(groups: CleanupSenderGroup[], requestedCount: number) {
  const ordered = orderCleanupResolutionGroups(groups);
  const allocations = new Map(ordered.map((group) => [group.index, 0]));
  let remaining = requestedCount;

  while (remaining > 0) {
    let allocatedThisRound = false;
    for (const group of ordered) {
      const allocated = allocations.get(group.index) ?? 0;
      if (allocated >= group.cleanupCandidateCount) continue;
      allocations.set(group.index, allocated + 1);
      remaining -= 1;
      allocatedThisRound = true;
      if (remaining === 0) break;
    }
    if (!allocatedThisRound) break;
  }

  return ordered
    .map((group) => ({ group, requestedCount: allocations.get(group.index) ?? 0 }))
    .filter((allocation) => allocation.requestedCount > 0);
}

export function orderCleanupResolutionGroups(groups: CleanupSenderGroup[]) {
  return [...groups]
    .filter((group) => group.eligible && group.cleanupCandidateCount > 0)
    .sort(compareCleanupResolutionGroups);
}

export function normalizeGmailCleanupSenderIdentity(input: string) {
  const address = input.trim().toLocaleLowerCase("en-US");
  if (!address || address === "unknown@unknown.invalid" || address.length > 320) return undefined;
  if (/[\s<>\[\],;:"\\\r\n]/u.test(address)) return undefined;
  const atIndex = address.lastIndexOf("@");
  if (atIndex <= 0 || atIndex !== address.indexOf("@") || atIndex === address.length - 1) return undefined;
  const local = address.slice(0, atIndex);
  const domain = address.slice(atIndex + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return undefined;
  if (!/^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+$/u.test(local)) return undefined;
  const domainLabels = domain.split(".");
  if (
    domainLabels.length < 2 ||
    domainLabels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label)
    )
  ) {
    return undefined;
  }
  return address;
}

export function buildGmailSenderCleanupQuery(input: { senderAddress: string; now?: Date }) {
  const now = input.now ?? new Date("2026-08-25T12:00:00Z");
  const senderAddress = normalizeGmailCleanupSenderIdentity(input.senderAddress);
  if (!senderAddress) throw new Error("Invalid canonical Gmail sender identity.");
  return [
    `from:("${escapeGmailQuotedQueryValue(senderAddress)}")`,
    "-in:trash",
    "-is:starred",
    "-is:important",
    "-in:sent",
    "-in:drafts",
    "-category:primary",
    `before:${formatGmailSearchDate(new Date(now.getTime() - cleanupAgeThresholdMs))}`
  ].join(" ");
}

export function isEligibleGmailApiCleanupCandidate(
  message: GmailMinimalMessageMetadata,
  context: GmailMutationSafetyContext
) {
  return assessGmailApiCleanupCandidate(message, context).eligible;
}

export function assessGmailApiCleanupCandidate(
  message: GmailMinimalMessageMetadata,
  context: GmailMutationSafetyContext
): GmailCandidateSafetyAssessment {
  const now = context.now ?? new Date();
  const labels = new Set((message.labelIds ?? []).map((label) => label.toUpperCase()));
  const exclusionReasons = new Set<GmailCleanupExclusionReason>();

  if (labels.has("TRASH")) exclusionReasons.add("ALREADY_TRASH");
  if (labels.has("STARRED")) exclusionReasons.add("STARRED");
  if (labels.has("IMPORTANT")) exclusionReasons.add("IMPORTANT");
  if (labels.has("SENT")) exclusionReasons.add("SENT");
  if (labels.has("DRAFT")) exclusionReasons.add("DRAFT");
  if (labels.has("CATEGORY_PERSONAL") || labels.has("CATEGORY_PRIMARY")) {
    exclusionReasons.add("PERSONAL_CATEGORY");
  }
  if (!message.threadId) {
    exclusionReasons.add("OTHER");
  } else if (context.participatedConversationIds.has(message.threadId)) {
    exclusionReasons.add("PARTICIPATED_CONVERSATION");
  }
  if (deriveSubjectProtection(getHeader(message, "Subject"))) {
    exclusionReasons.add("PROTECTED_SUBJECT");
  }

  const internalDate = message.internalDate ? new Date(Number(message.internalDate)) : undefined;
  if (!internalDate || Number.isNaN(internalDate.getTime())) {
    exclusionReasons.add("OTHER");
  } else if (!isOlderThanCleanupThreshold(internalDate, now)) {
    exclusionReasons.add("RECENT");
  }

  const sender = parseSender(getHeader(message, "From"));
  if (sender.address !== context.expectedSenderAddress.toLowerCase()) {
    exclusionReasons.add("SENDER_MISMATCH");
  }
  const protectedSenders = context.protectedSenders ?? new Set<string>();
  if (protectedSenders.has(sender.address) || (sender.domain && protectedSenders.has(sender.domain))) {
    exclusionReasons.add("PROTECTED_SENDER");
  }
  const hasStableStrongCleanupEvidence = hasStableStrongEvidence(message);
  const reliesOnMutableCategoryEvidence = !hasStableStrongCleanupEvidence && labels.has("CATEGORY_PROMOTIONS");
  if (!hasStableStrongCleanupEvidence && !reliesOnMutableCategoryEvidence) {
    exclusionReasons.add("STRONG_EVIDENCE_MISSING");
  }

  return {
    eligible: exclusionReasons.size === 0,
    exclusionReasons: [...exclusionReasons],
    hasStableStrongCleanupEvidence,
    reliesOnMutableCategoryEvidence
  };
}

export function createGmailCleanupExclusionCounts(): GmailCleanupExclusionCounts {
  return Object.fromEntries(gmailCleanupExclusionReasons.map((reason) => [reason, 0])) as GmailCleanupExclusionCounts;
}

export function addGmailCleanupExclusions(
  counts: GmailCleanupExclusionCounts,
  reasons: readonly GmailCleanupExclusionReason[]
) {
  for (const reason of reasons) counts[reason] += 1;
}

export function assessGmailMutableLabels(
  labelIds: Iterable<string>,
  requiresPromotionsEvidence: boolean
): GmailCleanupExclusionReason[] {
  const labels = new Set([...labelIds].map((label) => label.toUpperCase()));
  const reasons = new Set<GmailCleanupExclusionReason>();
  if (labels.has("TRASH")) reasons.add("ALREADY_TRASH");
  if (labels.has("STARRED")) reasons.add("STARRED");
  if (labels.has("IMPORTANT")) reasons.add("IMPORTANT");
  if (labels.has("SENT")) reasons.add("SENT");
  if (labels.has("DRAFT")) reasons.add("DRAFT");
  if (labels.has("CATEGORY_PERSONAL") || labels.has("CATEGORY_PRIMARY")) reasons.add("PERSONAL_CATEGORY");
  if (requiresPromotionsEvidence && !labels.has("CATEGORY_PROMOTIONS")) reasons.add("STRONG_EVIDENCE_MISSING");
  return [...reasons];
}

export function isOlderThanCleanupThreshold(receivedAt: Date, now = new Date()) {
  return now.getTime() - receivedAt.getTime() >= cleanupAgeThresholdMs;
}

function hasStableStrongEvidence(message: GmailMinimalMessageMetadata) {
  const precedence = getHeader(message, "Precedence")?.trim().toLowerCase();
  return (
    Boolean(getHeader(message, "List-Id")) ||
    Boolean(getHeader(message, "List-Unsubscribe")) ||
    precedence === "bulk" ||
    precedence === "list"
  );
}

function getCleanupGroupIneligibleReason(sender: SenderAggregate): CleanupSenderGroup["ineligibleReason"] {
  if (sender.protectionReasons.includes("PROTECTED_SENDER")) return "PROTECTED_SENDER";
  if (sender.cleanupCandidateCount <= 0) return "NO_READY_MESSAGES";
  if (sender.cleanupConfidence === "review") return "REVIEW_GROUP";
  if (sender.cleanupConfidence === "keep") return "KEEP_GROUP";
  return undefined;
}

function compareCleanupResolutionGroups(first: CleanupSenderGroup, second: CleanupSenderGroup) {
  const recommendationOrder = { very_high: 0, high: 1, review: 2, keep: 3 };
  return (
    recommendationOrder[first.cleanupConfidence] - recommendationOrder[second.cleanupConfidence] ||
    second.cleanupCandidateCount - first.cleanupCandidateCount ||
    first.index - second.index
  );
}

function getHeader(message: GmailMinimalMessageMetadata, name: string) {
  return message.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function escapeGmailQuotedQueryValue(value: string) {
  return value.replace(/[\\"]/g, "\\$&");
}

function formatGmailSearchDate(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}
