import type { FetchQueryObject } from "imapflow";
import { analyzeGmailLabels } from "@/lib/domain/gmail-labels";
import type { NormalizedMailboxRecord } from "@/lib/domain/types";
import { deriveSubjectProtection } from "@/lib/domain/subject-protection";

export const gmailHeaderAllowlist = ["From", "List-Id", "List-Unsubscribe", "Auto-Submitted", "Precedence", "Subject"] as const;

export const gmailFetchQuery = {
  uid: true,
  flags: true,
  internalDate: true,
  size: true,
  labels: true,
  threadId: true,
  headers: [...gmailHeaderAllowlist]
} satisfies FetchQueryObject;

export const gmailConversationIndexQuery = {
  threadId: true
} satisfies FetchQueryObject;

export function assertSafeGmailFetchQuery(query: FetchQueryObject = gmailFetchQuery) {
  if (query.source || query.bodyParts || query.bodyStructure || query.envelope || query.all || query.full || query.fast) {
    throw new Error("Unsafe Gmail fetch query: body, source, envelope, or macro fetches are not allowed.");
  }
  if (query.headers === true) {
    throw new Error("Unsafe Gmail fetch query: arbitrary headers are not allowed.");
  }
  const headers = Array.isArray(query.headers) ? query.headers.map((header) => header.toLowerCase()) : [];
  for (const header of headers) {
    if (!gmailHeaderAllowlist.map((allowed) => allowed.toLowerCase()).includes(header)) {
      throw new Error(`Unsafe Gmail fetch query: ${header} is not in the allowlist.`);
    }
  }
}

export function parseHeaderValue(headers: Buffer | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const text = headers.toString("utf8");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}:\\s*(.+(?:\\r?\\n[\\t ].+)*)`, "im"));
  return match?.[1]?.replace(/\r?\n[\t ]+/g, " ").trim();
}

export function parseSender(input: string | undefined): { address: string; displayName?: string; domain?: string } {
  const fallback = "unknown@unknown.invalid";
  if (!input) return { address: fallback, domain: "unknown.invalid" };
  const angleMatch = input.match(/^(.*?)<([^>]+)>/);
  const rawAddress = (angleMatch?.[2] ?? input).split(",")[0].trim().replace(/^"|"$/g, "");
  const address = rawAddress.includes("@") ? rawAddress.toLowerCase() : fallback;
  const displayName = angleMatch?.[1]?.trim().replace(/^"|"$/g, "") || undefined;
  const domain = address.split("@")[1];
  return { address, displayName, domain };
}

export function normalizeGmailMessage(input: {
  uid?: number;
  threadId?: string;
  headers?: Buffer;
  internalDate?: Date;
  flags?: Set<string>;
  labels?: Set<string> | string[];
  size?: number;
}, precomputedSubjectProtection = getGmailSubjectProtection(input.headers)): NormalizedMailboxRecord {
  const sender = parseSender(parseHeaderValue(input.headers, "From"));
  const labels = Array.isArray(input.labels) ? input.labels : [...(input.labels ?? [])];
  const labelAnalysis = analyzeGmailLabels(labels);
  const flags = input.flags ?? new Set<string>();
  const normalizedFlags = new Set([...flags].map(normalizeImapFlag));
  const listId = parseHeaderValue(input.headers, "List-Id");
  const autoSubmitted = parseHeaderValue(input.headers, "Auto-Submitted")?.trim().toLowerCase();
  const precedence = parseHeaderValue(input.headers, "Precedence")?.trim().toLowerCase();
  return {
    providerMessageId: input.uid ? `gmail-uid-${input.uid}` : "gmail-transient",
    provider: "gmail",
    senderAddress: sender.address,
    senderDisplayName: sender.displayName,
    senderDomain: sender.domain,
    receivedAt: input.internalDate ?? new Date(),
    isRead: normalizedFlags.has("\\SEEN"),
    estimatedSize: input.size,
    providerLabels: labels,
    userLabels: labelAnalysis.userLabels,
    hasListUnsubscribe: Boolean(parseHeaderValue(input.headers, "List-Unsubscribe")),
    listId,
    autoSubmitted,
    precedence,
    isStarred: normalizedFlags.has("\\FLAGGED") || labelAnalysis.systemLabels.has("STARRED"),
    isImportant: labelAnalysis.systemLabels.has("IMPORTANT"),
    isSent: labelAnalysis.systemLabels.has("SENT"),
    isDraft: labelAnalysis.systemLabels.has("DRAFT"),
    conversationId: input.threadId,
    subjectProtection: precomputedSubjectProtection
  };
}

export function getGmailSubjectProtection(headers: Buffer | undefined) {
  return deriveSubjectProtection(parseHeaderValue(headers, "Subject"));
}

function normalizeImapFlag(flag: string): string {
  return flag.trim().toUpperCase();
}
