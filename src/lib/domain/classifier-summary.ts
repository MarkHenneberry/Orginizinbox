import { recommendationLabel } from "./recommendations";
import type {
  ClassifierScanPerformance,
  InboxReport,
  SenderAggregate,
  SenderClassifierDiagnostics
} from "./types";

export type ClassifierSafetyChecks = {
  readyWithHardProtection: number;
  readyWithoutStrongSignal: number;
  countInvariantViolations: number;
};

export function getClassifierSafetyChecks(report: InboxReport): ClassifierSafetyChecks {
  return {
    readyWithHardProtection:
      report.classifierDiagnostics?.readyStrongSignals.withHardProtectionMessages ?? 0,
    readyWithoutStrongSignal:
      report.classifierDiagnostics?.readyStrongSignals.withoutStrongSignalMessages ?? 0,
    countInvariantViolations: countInvariantViolations(report)
  };
}

export function countInvariantViolations(report: InboxReport): number {
  let violations = violatesInvariant(
    report.totals.messages,
    report.totals.cleanupCandidates,
    report.totals.reviewMessages,
    report.totals.protectedMessages
  )
    ? 1
    : 0;

  for (const sender of report.senders) {
    violations += violatesInvariant(
      sender.totalMessages,
      sender.cleanupCandidateCount,
      sender.reviewMessages,
      sender.protectedMessages
    )
      ? 1
      : 0;
  }
  for (const category of report.categories) {
    violations += violatesInvariant(
      category.totalMessages,
      category.cleanupCandidateCount,
      category.reviewMessages,
      category.protectedMessages
    )
      ? 1
      : 0;
  }
  return violations;
}

export function formatMailboxClassifierSummary(
  report: InboxReport,
  performance?: ClassifierScanPerformance
): string {
  const diagnostics = requireMailboxDiagnostics(report);
  const signals = diagnostics.messageSignals;
  const safety = getClassifierSafetyChecks(report);
  const recommendations = countRecommendations(report);
  const gmailCategoriesUnavailable =
    diagnostics.gmailLabelCategory?.scanCategoryInput === "unavailable_through_imap_labels";
  const lines = [
    "ORGANIZINBOX DEV CLASSIFIER SUMMARY",
    "",
    "Mailbox",
    line("Total", report.totals.messages),
    line("Ready", report.totals.cleanupCandidates),
    line("Review", report.totals.reviewMessages),
    line("Protected", report.totals.protectedMessages),
    "",
    "Recommendations",
    line("Very High senders", recommendations.very_high),
    line("High senders", recommendations.high),
    line("Review senders", recommendations.review),
    line("Keep senders", recommendations.keep),
    "",
    "Protection reasons",
    line("Starred", signals.starredMessages),
    line("Important", signals.importantMessages),
    line("Recent", signals.recentMessages),
    line("Sent", signals.sentMessages),
    line("Draft", signals.draftMessages),
    availableLine("Personal category", signals.personalMessages, !gmailCategoriesUnavailable),
    line("Participated conversation", signals.participatedConversationMessages),
    line("User label", signals.userLabelMessages),
    line("Protected sender", signals.protectedSenderMessages),
    line("Transactional subject", signals.transactionalSubjectMessages),
    line("Security/account subject", signals.securityAccountSubjectMessages),
    "",
    "Strong cleanup evidence",
    line("List-Id", signals.listIdMessages),
    line("List-Unsubscribe", signals.listUnsubscribeMessages),
    line("Precedence bulk/list", signals.precedenceBulkOrListMessages),
    availableLine("Promotions", signals.promotionsMessages, !gmailCategoriesUnavailable),
    "",
    "Supporting evidence",
    availableLine("Social", signals.socialMessages, !gmailCategoriesUnavailable),
    line("Auto-Submitted", signals.autoSubmittedMessages),
    line("No-reply style", signals.noReplyStyleMessages),
    line("Old", signals.oldMessages),
    line("Very old", signals.veryOldMessages),
    line("Unread", signals.unreadMessages),
    "",
    "Conversation protection",
    line("Participated conversations indexed", diagnostics.participatedConversationsIndexed),
    line("Messages protected by participation", signals.participatedConversationMessages),
    "",
    "Safety checks",
    line("Ready with hard protection", safety.readyWithHardProtection),
    line("Ready without strong per-message bulk evidence", safety.readyWithoutStrongSignal),
    line("Count invariant violations", safety.countInvariantViolations),
    "",
    "Reason counts can overlap. Mailbox state counts do not overlap."
  ];

  appendPerformance(lines, performance);
  return lines.join("\n");
}

export function formatSenderClassifierSummary(sender: SenderAggregate): string {
  const diagnostics = requireSenderDiagnostics(sender);
  const signals = diagnostics.messageSignals;
  const readySignals = diagnostics.readyStrongSignals;

  return [
    "ORGANIZINBOX DEV SENDER SUMMARY",
    "",
    `Sender: ${sender.displayName}`,
    `Domain: ${sender.domain ?? "not available"}`,
    ...(sender.diagnosticSenderIdentity ? [`Identity: ${sender.diagnosticSenderIdentity}`] : []),
    "",
    `Recommendation: ${recommendationLabel(sender.cleanupConfidence)}`,
    "",
    "Counts",
    line("Total", diagnostics.totalMessages),
    line("Ready", diagnostics.readyMessages),
    line("Review", diagnostics.reviewMessages),
    line("Protected", diagnostics.protectedMessages),
    "",
    "Protection reasons",
    line("Flagged / starred", signals.starredMessages),
    line("Important", signals.importantMessages),
    line("Recent", signals.recentMessages),
    line("Sent", signals.sentMessages),
    line("Draft", signals.draftMessages),
    line("Personal", signals.personalMessages),
    line("Participated conversation", signals.participatedConversationMessages),
    line("User label", signals.userLabelMessages),
    line("Protected sender", signals.protectedSenderMessages),
    line(
      "Subject protection",
      (signals.transactionalSubjectMessages ?? 0) + (signals.securityAccountSubjectMessages ?? 0)
    ),
    "",
    "Ready-message strong evidence",
    line("List-Id", readySignals.listIdMessages),
    line("List-Unsubscribe", readySignals.listUnsubscribeMessages),
    line("Precedence bulk/list", readySignals.precedenceBulkOrListMessages),
    line("Promotions", readySignals.promotionsMessages),
    "",
    "Supporting evidence",
    line("Social", signals.socialMessages),
    line("Auto-Submitted", signals.autoSubmittedMessages),
    line("No-reply style", signals.noReplyStyleMessages),
    line("Old", signals.oldMessages),
    line("Very old", signals.veryOldMessages),
    line("Unread", signals.unreadMessages),
    `Recurring sender: ${sender.recurring ? "yes" : "no"}`,
    "",
    "Safety",
    line("Ready with hard protection", readySignals.withHardProtectionMessages),
    line("Ready without strong signal", readySignals.withoutStrongSignalMessages),
    "",
    "Reason counts can overlap. Final state counts do not overlap."
  ].join("\n");
}

export function formatGmailLabelCategoryDiagnostic(report: InboxReport): string {
  const diagnostics = requireMailboxDiagnostics(report).gmailLabelCategory;
  if (!diagnostics) {
    throw new Error("Gmail label/category diagnostics are not available for this report.");
  }
  const system = diagnostics.normalizedSystemLabelMessages;
  const imapCategories = diagnostics.observedImapCategoryLabelMessages;
  const providerCategories = diagnostics.observedProviderCategoryMessages;

  return [
    "ORGANIZINBOX DEV GMAIL LABEL/CATEGORY DIAGNOSTIC",
    "",
    "Scan-time category input: unavailable through the current X-GM-LABELS fetch",
    line("Messages with any Gmail labels", diagnostics.messagesWithAnyGmailLabels),
    "",
    "Observed normalized system labels",
    line("STARRED", system.starred),
    line("IMPORTANT", system.important),
    line("SENT", system.sent),
    line("DRAFT", system.draft),
    "",
    "Observed X-GM-LABELS category-shaped values (diagnostic only)",
    line("PROMOTIONS", imapCategories.promotions),
    line("SOCIAL", imapCategories.social),
    line("PERSONAL/PRIMARY", imapCategories.personal),
    line("UPDATES", imapCategories.updates),
    "",
    "Observed scan-time provider categories",
    availableLine("PROMOTIONS", providerCategories.promotions, false),
    availableLine("SOCIAL", providerCategories.social, false),
    availableLine("PERSONAL/PRIMARY", providerCategories.personal, false),
    availableLine("UPDATES", providerCategories.updates, false),
    "",
    "Private user-label aggregates",
    line("Messages with user labels", diagnostics.messagesWithUserLabels),
    line("Distinct user labels observed", diagnostics.distinctUserLabelsObserved),
    line(
      "Unrecognized system/category-shaped labels",
      diagnostics.unrecognizedSystemOrCategoryShapedLabels
    ),
    "",
    "Auto-Submitted",
    line("Header present", diagnostics.autoSubmittedHeaderPresentMessages),
    line("Values indicating automation", diagnostics.autoSubmittedAutomationMessages),
    "",
    "No user-label names, message IDs, Subjects or raw headers are included."
  ].join("\n");
}

function requireMailboxDiagnostics(report: InboxReport) {
  if (!report.classifierDiagnostics) {
    throw new Error("Classifier diagnostics are not available for this report.");
  }
  return report.classifierDiagnostics;
}

function requireSenderDiagnostics(sender: SenderAggregate): SenderClassifierDiagnostics {
  if (!sender.diagnostics) {
    throw new Error("Classifier diagnostics are not available for this sender.");
  }
  return sender.diagnostics;
}

function countRecommendations(report: InboxReport) {
  const counts = { very_high: 0, high: 0, review: 0, keep: 0 };
  for (const sender of report.senders) counts[sender.cleanupConfidence] += 1;
  return counts;
}

function violatesInvariant(total: number, ready: number, review: number, protectedCount: number) {
  return total !== ready + review + protectedCount;
}

function line(label: string, value: number | undefined) {
  return `${label}: ${(value ?? 0).toLocaleString("en-US")}`;
}

function availableLine(label: string, value: number | undefined, available: boolean) {
  return available ? line(label, value) : `${label}: unavailable`;
}

function appendPerformance(lines: string[], performance?: ClassifierScanPerformance) {
  if (!performance) return;
  const timings: Array<[string, number | undefined]> = [
    ["Sent conversation indexing", performance.conversationIndexMs],
    ["Metadata fetch", performance.metadataMs],
    ["Subject protection", performance.subjectProtectionMs],
    ["Protection classification", performance.protectionClassificationMs],
    ["Aggregation", performance.aggregationMs],
    ["Total scan", performance.durationMs]
  ];
  const available = timings.filter((timing): timing is [string, number] => timing[1] !== undefined);
  if (available.length === 0) return;
  lines.push("", "Performance", ...available.map(([label, value]) => `${label}: ${value} ms`));
}
