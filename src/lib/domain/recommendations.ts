import { classifyMessage, isAutoSubmitted } from "./classification";
import { getAgeBand, getProtectionReasons } from "./safety";
import type {
  ClassifiedMessage,
  CleanupReason,
  CleanupRecommendation,
  CleanupSignal,
  MailCategory,
  NormalizedMessageMetadata,
  ProtectionReason,
  ReviewSignal
} from "./types";

export const STRONG_CLEANUP_SIGNALS = new Set<CleanupSignal>([
  "HAS_LIST_ID",
  "HAS_LIST_UNSUBSCRIBE",
  "PRECEDENCE_BULK",
  "PRECEDENCE_LIST",
  "CATEGORY_PROMOTIONS"
]);

export const RECURRING_SENDER_MIN_MESSAGES = 3;
export const VERY_HIGH_MIN_ELIGIBLE_MESSAGES = 25;
export const VERY_HIGH_OLD_RATIO = 0.75;
export const VERY_HIGH_VERY_OLD_RATIO = 0.5;
export const MOSTLY_UNREAD_RATIO = 0.8;
export const SIGNIFICANT_PROTECTED_RATIO = 0.4;

export type AssessmentContext = {
  now?: Date;
  protectedSenders?: Set<string>;
  participatedConversationIds?: ReadonlySet<string>;
};

export type SenderRecommendationInput = {
  totalMessages: number;
  protectedMessages: number;
  preliminarilyEligibleMessages: number;
  unreadMessages: number;
  oldMessages: number;
  veryOldMessages: number;
  strongCleanupSignals: ReadonlySet<CleanupSignal>;
  reviewSignals: ReadonlySet<ReviewSignal>;
  dominantClass: MailCategory;
};

export type SenderRecommendationResult = {
  recommendation: CleanupRecommendation;
  reasonCodes: CleanupReason[];
  recurring: boolean;
};

export function assessMessage(
  message: NormalizedMessageMetadata,
  context: AssessmentContext = {}
): ClassifiedMessage {
  const now = context.now ?? new Date();
  const mailClass = classifyMessage(message);
  const ageBand = getAgeBand(message.receivedAt, now);
  const protectionReasons = getProtectionReasons({
    message,
    mailClass,
    now,
    protectedSenders: context.protectedSenders,
    participatedConversationIds: context.participatedConversationIds
  });
  const reviewSignals = getReviewSignals(message, mailClass);
  const cleanupSignals = getCleanupSignals(message, ageBand);
  const hasStrongCleanupSignal = cleanupSignals.some((signal) => STRONG_CLEANUP_SIGNALS.has(signal));
  const eligibleForCleanup =
    protectionReasons.length === 0 &&
    (ageBand === "old" || ageBand === "very_old") &&
    hasStrongCleanupSignal;

  return {
    ...message,
    category: mailClass,
    mailClass,
    ageBand,
    protectionReasons,
    reviewSignals,
    cleanupSignals,
    eligibleForCleanup,
    isProtected: protectionReasons.length > 0
  };
}

export function classifyAndProtectMessages(
  messages: NormalizedMessageMetadata[],
  now = new Date(),
  context: Omit<AssessmentContext, "now"> = {}
): ClassifiedMessage[] {
  return messages.map((message) => assessMessage(message, { ...context, now }));
}

export function getReviewSignals(message: NormalizedMessageMetadata, mailClass: MailCategory): ReviewSignal[] {
  const signals = new Set<ReviewSignal>();
  if ((message.userLabels?.length ?? 0) > 0) signals.add("USER_LABEL_PRESENT");
  if (mailClass === "ACCOUNT_OR_TRANSACTIONAL" || message.providerCategory === "updates") {
    signals.add("TRANSACTIONAL_OR_ACCOUNT_LIKE");
  }
  if (mailClass === "UNKNOWN") signals.add("UNKNOWN_MAIL_TYPE");
  return [...signals];
}

export function getCleanupSignals(
  message: NormalizedMessageMetadata,
  ageBand: ClassifiedMessage["ageBand"]
): CleanupSignal[] {
  const signals = new Set<CleanupSignal>();
  const precedence = message.precedence?.trim().toLowerCase();

  if (message.listId) signals.add("HAS_LIST_ID");
  if (message.hasListUnsubscribe) signals.add("HAS_LIST_UNSUBSCRIBE");
  if (precedence === "bulk") signals.add("PRECEDENCE_BULK");
  if (precedence === "list") signals.add("PRECEDENCE_LIST");
  if (message.providerCategory === "promotions") signals.add("CATEGORY_PROMOTIONS");
  if (message.providerCategory === "social") signals.add("CATEGORY_SOCIAL");
  if (isAutoSubmitted(message.autoSubmitted)) signals.add("AUTO_SUBMITTED");
  if (isNoReplyStyleSender(message.senderAddress)) signals.add("NOREPLY_STYLE_SENDER");
  if (ageBand === "old") signals.add("OLD_MAIL");
  if (ageBand === "very_old") {
    signals.add("OLD_MAIL");
    signals.add("VERY_OLD_MAIL");
  }

  return [...signals];
}

export function recommendSenderGroup(input: SenderRecommendationInput): SenderRecommendationResult {
  const recurring = input.totalMessages >= RECURRING_SENDER_MIN_MESSAGES;
  const reasonCodes = new Set<CleanupReason>();
  input.strongCleanupSignals.forEach((signal) => reasonCodes.add(signal));
  input.reviewSignals.forEach((signal) => reasonCodes.add(signal));

  if (recurring) reasonCodes.add("RECURRING_SENDER");
  if (input.unreadMessages / input.totalMessages >= MOSTLY_UNREAD_RATIO) reasonCodes.add("MOSTLY_UNREAD");
  if (input.oldMessages / input.totalMessages >= VERY_HIGH_OLD_RATIO) reasonCodes.add("PREDOMINANTLY_OLD");
  if (input.veryOldMessages / input.totalMessages >= VERY_HIGH_VERY_OLD_RATIO) reasonCodes.add("PREDOMINANTLY_VERY_OLD");
  if (input.strongCleanupSignals.size >= 2) reasonCodes.add("MULTIPLE_STRONG_BULK_SIGNALS");
  if (input.preliminarilyEligibleMessages >= VERY_HIGH_MIN_ELIGIBLE_MESSAGES) reasonCodes.add("SUBSTANTIAL_ELIGIBLE_VOLUME");

  const protectedRatio = input.protectedMessages / input.totalMessages;
  if (protectedRatio >= SIGNIFICANT_PROTECTED_RATIO && input.protectedMessages < input.totalMessages) {
    reasonCodes.add("SIGNIFICANT_PROTECTED_SUBSET");
    return { recommendation: "review", reasonCodes: [...reasonCodes], recurring };
  }
  if (input.protectedMessages === input.totalMessages) {
    return { recommendation: "keep", reasonCodes: [...reasonCodes], recurring };
  }
  if (input.reviewSignals.has("USER_LABEL_PRESENT")) {
    return { recommendation: "review", reasonCodes: [...reasonCodes], recurring };
  }
  if (input.preliminarilyEligibleMessages === 0) {
    reasonCodes.add("INSUFFICIENT_BULK_EVIDENCE");
    const recommendation =
      input.dominantClass === "PERSONAL" || input.dominantClass === "UNKNOWN" ? "keep" : "review";
    return { recommendation, reasonCodes: [...reasonCodes], recurring };
  }
  if (!recurring) {
    return { recommendation: "review", reasonCodes: [...reasonCodes], recurring };
  }

  const veryHigh =
    input.strongCleanupSignals.size >= 2 &&
    input.preliminarilyEligibleMessages >= VERY_HIGH_MIN_ELIGIBLE_MESSAGES &&
    (input.oldMessages / input.totalMessages >= VERY_HIGH_OLD_RATIO ||
      input.veryOldMessages / input.totalMessages >= VERY_HIGH_VERY_OLD_RATIO);

  return {
    recommendation: veryHigh ? "very_high" : "high",
    reasonCodes: [...reasonCodes],
    recurring
  };
}

export function recommendationLabel(value: CleanupRecommendation): string {
  return {
    very_high: "Very High",
    high: "High",
    review: "Review",
    keep: "Keep"
  }[value];
}

export function categoryLabel(value: MailCategory): string {
  return {
    BULK_NEWSLETTER: "Newsletters & bulk mail",
    PROMOTIONAL: "Promotions",
    SOCIAL_AUTOMATION: "Social notifications",
    ACCOUNT_OR_TRANSACTIONAL: "Account & transactional",
    PERSONAL: "Personal",
    UNKNOWN: "Unknown"
  }[value];
}

const recommendationReasonCopy: Record<CleanupReason, string> = {
  HAS_LIST_ID: "Mailing-list headers found",
  HAS_LIST_UNSUBSCRIBE: "Unsubscribe information found",
  PRECEDENCE_BULK: "Marked as bulk mail",
  PRECEDENCE_LIST: "Marked as list mail",
  CATEGORY_PROMOTIONS: "Gmail categorized these as promotions",
  CATEGORY_SOCIAL: "Gmail categorized these as social notifications",
  AUTO_SUBMITTED: "Messages appear to be sent automatically",
  NOREPLY_STYLE_SENDER: "The sender address looks automated",
  RECURRING_SENDER: "This sender appears regularly",
  MOSTLY_UNREAD: "Most messages are unread",
  OLD_MAIL: "Older mail is present",
  VERY_OLD_MAIL: "Mail older than one year is present",
  USER_LABEL_PRESENT: "Some messages have your labels",
  TRANSACTIONAL_OR_ACCOUNT_LIKE: "Looks like account or transactional mail",
  UNKNOWN_MAIL_TYPE: "The mail type is uncertain",
  PROTECTED_STARRED: "Starred messages are protected",
  PROTECTED_IMPORTANT: "Important messages are protected",
  PROTECTED_RECENT: "Recent messages are protected",
  PROTECTED_USER_PARTICIPATED_CONVERSATION: "Conversations you participated in are protected",
  PROTECTED_PERSONAL: "Personal messages are protected",
  PROTECTED_SENT: "Sent messages are protected",
  PROTECTED_DRAFT: "Drafts are protected",
  PROTECTED_SENDER: "This sender is protected",
  PROTECTED_TRANSACTIONAL_SUBJECT: "Looks like this message may contain a receipt or account record",
  PROTECTED_SECURITY_ACCOUNT_SUBJECT: "Looks like this message may contain an account or security notice",
  MULTIPLE_STRONG_BULK_SIGNALS: "Several independent bulk-mail signals agree",
  SUBSTANTIAL_ELIGIBLE_VOLUME: "Many messages meet the cleanup rules",
  PREDOMINANTLY_OLD: "Most messages are older than six months",
  PREDOMINANTLY_VERY_OLD: "Most messages are older than one year",
  SIGNIFICANT_PROTECTED_SUBSET: "Many messages in this group are protected",
  INSUFFICIENT_BULK_EVIDENCE: "There is not enough bulk-mail evidence"
};

export function recommendationReasonText(reason: CleanupReason): string {
  return recommendationReasonCopy[reason];
}

export function protectionReasonText(reason: ProtectionReason): string {
  return recommendationReasonCopy[reason];
}

function isNoReplyStyleSender(senderAddress: string): boolean {
  const localPart = senderAddress.split("@")[0]?.toLowerCase() ?? "";
  return /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|alerts?|updates?)([._+-]|$)/.test(localPart);
}
