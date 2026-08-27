import type { MailCategory, NormalizedMessageMetadata } from "./types";

export function classifyMessage(message: NormalizedMessageMetadata): MailCategory {
  if (message.providerCategory === "personal") return "PERSONAL";
  if (message.providerCategory === "promotions") return "PROMOTIONAL";
  if (message.listId || message.hasListUnsubscribe || isBulkPrecedence(message.precedence)) {
    return "BULK_NEWSLETTER";
  }
  if (message.providerCategory === "social") return "SOCIAL_AUTOMATION";
  if (message.providerCategory === "updates" || isAutoSubmitted(message.autoSubmitted)) {
    return "ACCOUNT_OR_TRANSACTIONAL";
  }
  return "UNKNOWN";
}

export function isAutoSubmitted(value: string | undefined): boolean {
  return Boolean(value && value.trim().toLowerCase() !== "no");
}

function isBulkPrecedence(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "bulk" || normalized === "list";
}
