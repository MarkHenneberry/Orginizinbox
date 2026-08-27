import type { AgeBand, MailCategory, NormalizedMessageMetadata, ProtectionReason } from "./types";

export const DEFAULT_RECENT_PROTECTION_DAYS = 30;
export const OLD_MAIL_DAYS = 180;
export const VERY_OLD_MAIL_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

type ProtectionInput = {
  message: NormalizedMessageMetadata;
  mailClass: MailCategory;
  now?: Date;
  recentProtectionDays?: number;
  protectedSenders?: Set<string>;
  participatedConversationIds?: ReadonlySet<string>;
};

export function getAgeBand(
  receivedAt: Date,
  now = new Date(),
  recentProtectionDays = DEFAULT_RECENT_PROTECTION_DAYS
): AgeBand {
  const ageDays = Math.max(0, now.getTime() - receivedAt.getTime()) / DAY_MS;
  if (ageDays < recentProtectionDays) return "recent";
  if (ageDays >= VERY_OLD_MAIL_DAYS) return "very_old";
  if (ageDays >= OLD_MAIL_DAYS) return "old";
  return "current";
}

export function getProtectionReasons({
  message,
  mailClass,
  now = new Date(),
  recentProtectionDays = DEFAULT_RECENT_PROTECTION_DAYS,
  protectedSenders = new Set(),
  participatedConversationIds = new Set()
}: ProtectionInput): ProtectionReason[] {
  const reasons = new Set<ProtectionReason>();
  const ageBand = getAgeBand(message.receivedAt, now, recentProtectionDays);

  if (message.isStarred) reasons.add("PROTECTED_STARRED");
  if (message.isImportant) reasons.add("PROTECTED_IMPORTANT");
  if (ageBand === "recent") reasons.add("PROTECTED_RECENT");
  if (message.isSent) reasons.add("PROTECTED_SENT");
  if (message.isDraft) reasons.add("PROTECTED_DRAFT");
  if (message.subjectProtection === "transactional") reasons.add("PROTECTED_TRANSACTIONAL_SUBJECT");
  if (message.subjectProtection === "security_account") reasons.add("PROTECTED_SECURITY_ACCOUNT_SUBJECT");
  if (mailClass === "PERSONAL" || message.providerCategory === "personal") reasons.add("PROTECTED_PERSONAL");
  if (!message.isSent && message.conversationId && participatedConversationIds.has(message.conversationId)) {
    reasons.add("PROTECTED_USER_PARTICIPATED_CONVERSATION");
  }

  const normalizedSender = message.senderAddress.toLowerCase();
  const normalizedDomain = message.senderDomain?.toLowerCase();
  if (protectedSenders.has(normalizedSender) || (normalizedDomain && protectedSenders.has(normalizedDomain))) {
    reasons.add("PROTECTED_SENDER");
  }

  return [...reasons];
}

export function indexSentConversation(
  message: Pick<NormalizedMessageMetadata, "isSent" | "conversationId">,
  participatedConversationIds: Set<string>
): void {
  if (message.isSent && message.conversationId) {
    participatedConversationIds.add(message.conversationId);
  }
}
