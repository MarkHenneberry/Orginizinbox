import {
  STRONG_CLEANUP_SIGNALS,
  assessMessage,
  recommendSenderGroup,
  type AssessmentContext
} from "./recommendations";
import { analyzeGmailLabels } from "./gmail-labels";
import type {
  CategoryAggregate,
  ClassifiedMessage,
  CleanupReason,
  CleanupRecommendation,
  CleanupSignal,
  InboxReport,
  GmailLabelCategoryDiagnostics,
  MailboxClassifierDiagnostics,
  MailCategory,
  NormalizedMailboxRecord,
  ProtectionReason,
  ReviewSignal,
  SenderClassifierDiagnostics,
  SenderAggregate
} from "./types";

type CategoryBucket = {
  totalMessages: number;
  unreadMessages: number;
  oldMessages: number;
  protectedMessages: number;
  preliminarilyEligibleMessages: number;
  estimatedBytes: number;
  preliminarilyEligibleBytes: number;
};

type SenderBucket = {
  senderKey: string;
  displayName: string;
  domain?: string;
  totalMessages: number;
  unreadMessages: number;
  oldMessages: number;
  veryOldMessages: number;
  recentMessages: number;
  protectedMessages: number;
  preliminarilyEligibleMessages: number;
  oldestMessageAt: Date;
  newestMessageAt: Date;
  estimatedBytes: number;
  preliminarilyEligibleBytes: number;
  categoryCounts: Map<MailCategory, number>;
  categoryBuckets: Map<MailCategory, CategoryBucket>;
  cleanupSignals: Set<CleanupSignal>;
  strongCleanupSignals: Set<CleanupSignal>;
  reviewSignals: Set<ReviewSignal>;
  protectionReasons: Set<ProtectionReason>;
  diagnostics: {
    messageSignals: SenderClassifierDiagnostics["messageSignals"];
    preliminaryReadyStrongSignals: SenderClassifierDiagnostics["readyStrongSignals"];
  };
};

type StreamingReportAggregatorContext = AssessmentContext & {
  includeDiagnostics?: boolean;
};

const confidenceRank: Record<CleanupRecommendation, number> = {
  keep: 0,
  review: 1,
  high: 2,
  very_high: 3
};

export type AggregationTiming = {
  protectionClassificationMs: number;
  aggregationMs: number;
};

export class StreamingReportAggregator {
  private readonly senderBuckets = new Map<string, SenderBucket>();
  private readonly now: Date;
  private readonly assessmentContext: AssessmentContext;
  private readonly includeDiagnostics: boolean;
  private readonly participatedConversationsIndexed: number;
  private processedMessages = 0;
  private unreadOlderThanOneYear = 0;
  private protectedMessages = 0;
  private readonly gmailLabelCategoryDiagnostics = createGmailLabelCategoryDiagnostics();
  private readonly distinctGmailUserLabels = new Set<string>();

  constructor(context: StreamingReportAggregatorContext = {}) {
    this.now = context.now ?? new Date();
    this.assessmentContext = { ...context, now: this.now };
    this.includeDiagnostics = context.includeDiagnostics === true;
    this.participatedConversationsIndexed = context.participatedConversationIds?.size ?? 0;
  }

  process(record: NormalizedMailboxRecord): AggregationTiming {
    return this.processBatch([record]);
  }

  processBatch(records: Iterable<NormalizedMailboxRecord>): AggregationTiming {
    let protectionClassificationMs = 0;
    let aggregationMs = 0;

    for (const record of records) {
      const classificationStarted = performance.now();
      const classified = assessMessage(record, this.assessmentContext);
      protectionClassificationMs += performance.now() - classificationStarted;

      const aggregationStarted = performance.now();
      this.processClassified(classified);
      aggregationMs += performance.now() - aggregationStarted;
    }

    return { protectionClassificationMs, aggregationMs };
  }

  snapshot(provider: "gmail" | "microsoft", fixtureMode = false): InboxReport {
    const senderResults = [...this.senderBuckets.values()].map((bucket) => ({
      bucket,
      sender: this.toSenderAggregate(bucket)
    }));
    const senders = senderResults.map(({ sender }) => sender).sort((a, b) => b.totalMessages - a.totalMessages);
    const categories = this.buildCategoryAggregates(senderResults);
    const cleanupCandidates = senders.reduce((total, sender) => total + sender.cleanupCandidateCount, 0);

    return {
      generatedAt: this.now,
      provider,
      fixtureMode,
      totals: {
        messages: this.processedMessages,
        cleanupCandidates,
        unreadOlderThanOneYear: this.unreadOlderThanOneYear,
        recurringSenders: senders.filter((sender) => sender.recurring).length,
        protectedMessages: this.protectedMessages,
        reviewMessages: getReviewCount(this.processedMessages, cleanupCandidates, this.protectedMessages),
        estimatedRecoverableBytes: senders.reduce((total, sender) => total + sender.estimatedEligibleBytes, 0)
      },
      senders,
      categories,
      classifierDiagnostics: this.includeDiagnostics
        ? buildMailboxDiagnostics(
            senders,
            this.participatedConversationsIndexed,
            provider === "gmail" ? this.finalizeGmailLabelCategoryDiagnostics() : undefined
          )
        : undefined
    };
  }

  private processClassified(message: ClassifiedMessage) {
    const senderKey = message.senderAddress.toLowerCase();
    const existing = this.senderBuckets.get(senderKey);
    const bucket = existing ?? createSenderBucket(message, senderKey);
    const old = message.ageBand === "old" || message.ageBand === "very_old";

    bucket.totalMessages += 1;
    bucket.unreadMessages += message.isRead ? 0 : 1;
    bucket.oldMessages += old ? 1 : 0;
    bucket.veryOldMessages += message.ageBand === "very_old" ? 1 : 0;
    bucket.recentMessages += message.ageBand === "recent" ? 1 : 0;
    bucket.protectedMessages += message.isProtected ? 1 : 0;
    bucket.preliminarilyEligibleMessages += message.eligibleForCleanup ? 1 : 0;
    bucket.oldestMessageAt = new Date(Math.min(bucket.oldestMessageAt.getTime(), message.receivedAt.getTime()));
    bucket.newestMessageAt = new Date(Math.max(bucket.newestMessageAt.getTime(), message.receivedAt.getTime()));
    bucket.estimatedBytes += message.estimatedSize ?? 0;
    bucket.preliminarilyEligibleBytes += message.eligibleForCleanup ? (message.estimatedSize ?? 0) : 0;
    bucket.categoryCounts.set(message.category, (bucket.categoryCounts.get(message.category) ?? 0) + 1);
    message.cleanupSignals.forEach((signal) => {
      bucket.cleanupSignals.add(signal);
      if (STRONG_CLEANUP_SIGNALS.has(signal)) bucket.strongCleanupSignals.add(signal);
    });
    message.reviewSignals.forEach((signal) => bucket.reviewSignals.add(signal));
    message.protectionReasons.forEach((reason) => bucket.protectionReasons.add(reason));
    if (this.includeDiagnostics) {
      updateSenderDiagnostics(bucket, message);
      if (message.provider === "gmail") {
        updateGmailLabelCategoryDiagnostics(
          this.gmailLabelCategoryDiagnostics,
          this.distinctGmailUserLabels,
          message
        );
      }
    }
    updateCategoryBucket(bucket, message, old);
    this.senderBuckets.set(senderKey, bucket);

    this.processedMessages += 1;
    this.unreadOlderThanOneYear += !message.isRead && message.ageBand === "very_old" ? 1 : 0;
    this.protectedMessages += message.isProtected ? 1 : 0;
  }

  private finalizeGmailLabelCategoryDiagnostics(): GmailLabelCategoryDiagnostics {
    return {
      ...this.gmailLabelCategoryDiagnostics,
      normalizedSystemLabelMessages: { ...this.gmailLabelCategoryDiagnostics.normalizedSystemLabelMessages },
      observedImapCategoryLabelMessages: { ...this.gmailLabelCategoryDiagnostics.observedImapCategoryLabelMessages },
      observedProviderCategoryMessages: { ...this.gmailLabelCategoryDiagnostics.observedProviderCategoryMessages },
      distinctUserLabelsObserved: this.distinctGmailUserLabels.size
    };
  }

  private toSenderAggregate(bucket: SenderBucket): SenderAggregate {
    const dominantClass = mostCommonCategory(bucket.categoryCounts);
    const decision = recommendSenderGroup({
      totalMessages: bucket.totalMessages,
      protectedMessages: bucket.protectedMessages,
      preliminarilyEligibleMessages: bucket.preliminarilyEligibleMessages,
      unreadMessages: bucket.unreadMessages,
      oldMessages: bucket.oldMessages,
      veryOldMessages: bucket.veryOldMessages,
      strongCleanupSignals: bucket.strongCleanupSignals,
      reviewSignals: bucket.reviewSignals,
      dominantClass
    });
    const cleanupEligible = decision.recommendation === "high" || decision.recommendation === "very_high";
    const cleanupCandidateCount = cleanupEligible ? bucket.preliminarilyEligibleMessages : 0;
    const reasonCodes = orderReasons(
      uniqueReasons([...decision.reasonCodes, ...bucket.cleanupSignals, ...bucket.reviewSignals]),
      decision.recommendation
    );

    return {
      senderKey: bucket.senderKey,
      displayName: bucket.displayName,
      domain: bucket.domain,
      totalMessages: bucket.totalMessages,
      unreadMessages: bucket.unreadMessages,
      readMessages: bucket.totalMessages - bucket.unreadMessages,
      unreadRatio: bucket.unreadMessages / bucket.totalMessages,
      oldMessages: bucket.oldMessages,
      veryOldMessages: bucket.veryOldMessages,
      recentMessages: bucket.recentMessages,
      protectedMessages: bucket.protectedMessages,
      reviewMessages: getReviewCount(bucket.totalMessages, cleanupCandidateCount, bucket.protectedMessages),
      cleanupCandidateCount,
      oldestMessageAt: bucket.oldestMessageAt,
      newestMessageAt: bucket.newestMessageAt,
      estimatedBytes: bucket.estimatedBytes,
      estimatedEligibleBytes: cleanupEligible ? bucket.preliminarilyEligibleBytes : 0,
      recurring: decision.recurring,
      classification: dominantClass,
      cleanupConfidence: decision.recommendation,
      reasonCodes,
      protectionReasons: [...bucket.protectionReasons],
      diagnostics: this.includeDiagnostics
        ? buildSenderDiagnostics(bucket, cleanupCandidateCount)
        : undefined
    };
  }

  private buildCategoryAggregates(
    senderResults: Array<{ bucket: SenderBucket; sender: SenderAggregate }>
  ): CategoryAggregate[] {
    const categories = new Map<MailCategory, CategoryAggregate>();
    for (const { bucket, sender } of senderResults) {
      const cleanupEligible = sender.cleanupConfidence === "high" || sender.cleanupConfidence === "very_high";
      for (const [category, stats] of bucket.categoryBuckets) {
        const existing = categories.get(category) ?? createCategoryAggregate(category);
        existing.totalMessages += stats.totalMessages;
        existing.unreadMessages += stats.unreadMessages;
        existing.oldMessages += stats.oldMessages;
        existing.protectedMessages += stats.protectedMessages;
        existing.cleanupCandidateCount += cleanupEligible ? stats.preliminarilyEligibleMessages : 0;
        existing.estimatedBytes += stats.estimatedBytes;
        existing.estimatedEligibleBytes += cleanupEligible ? stats.preliminarilyEligibleBytes : 0;
        if (confidenceRank[sender.cleanupConfidence] > confidenceRank[existing.topRecommendation]) {
          existing.topRecommendation = sender.cleanupConfidence;
        }
        categories.set(category, existing);
      }
    }
    return [...categories.values()]
      .map((category) => ({
        ...category,
        reviewMessages: getReviewCount(
          category.totalMessages,
          category.cleanupCandidateCount,
          category.protectedMessages
        )
      }))
      .sort((a, b) => b.totalMessages - a.totalMessages);
  }
}

function createSenderBucket(message: ClassifiedMessage, senderKey: string): SenderBucket {
  return {
    senderKey,
    displayName: message.senderDisplayName ?? senderKey,
    domain: message.senderDomain,
    totalMessages: 0,
    unreadMessages: 0,
    oldMessages: 0,
    veryOldMessages: 0,
    recentMessages: 0,
    protectedMessages: 0,
    preliminarilyEligibleMessages: 0,
    oldestMessageAt: message.receivedAt,
    newestMessageAt: message.receivedAt,
    estimatedBytes: 0,
    preliminarilyEligibleBytes: 0,
    categoryCounts: new Map<MailCategory, number>(),
    categoryBuckets: new Map<MailCategory, CategoryBucket>(),
    cleanupSignals: new Set<CleanupSignal>(),
    strongCleanupSignals: new Set<CleanupSignal>(),
    reviewSignals: new Set<ReviewSignal>(),
    protectionReasons: new Set<ProtectionReason>(),
    diagnostics: {
      messageSignals: createMessageSignalDiagnostics(),
      preliminaryReadyStrongSignals: createReadyStrongSignalDiagnostics()
    }
  };
}

function updateSenderDiagnostics(bucket: SenderBucket, message: ClassifiedMessage) {
  const signals = bucket.diagnostics.messageSignals;
  signals.starredMessages += message.isStarred ? 1 : 0;
  signals.importantMessages += message.isImportant ? 1 : 0;
  signals.recentMessages += message.ageBand === "recent" ? 1 : 0;
  signals.sentMessages += message.isSent ? 1 : 0;
  signals.draftMessages += message.isDraft ? 1 : 0;
  signals.personalMessages += message.mailClass === "PERSONAL" ? 1 : 0;
  signals.participatedConversationMessages += message.protectionReasons.includes(
    "PROTECTED_USER_PARTICIPATED_CONVERSATION"
  )
    ? 1
    : 0;
  signals.userLabelMessages += (message.userLabels?.length ?? 0) > 0 ? 1 : 0;
  signals.protectedSenderMessages += message.protectionReasons.includes("PROTECTED_SENDER") ? 1 : 0;
  signals.transactionalSubjectMessages += message.subjectProtection === "transactional" ? 1 : 0;
  signals.securityAccountSubjectMessages += message.subjectProtection === "security_account" ? 1 : 0;
  signals.listIdMessages += message.listId ? 1 : 0;
  signals.listUnsubscribeMessages += message.hasListUnsubscribe ? 1 : 0;
  signals.precedenceBulkOrListMessages += isBulkOrListPrecedence(message.precedence) ? 1 : 0;
  signals.promotionsMessages += message.providerCategory === "promotions" ? 1 : 0;
  signals.updatesMessages += message.providerCategory === "updates" ? 1 : 0;
  signals.socialMessages += message.providerCategory === "social" ? 1 : 0;
  signals.autoSubmittedMessages += message.cleanupSignals.includes("AUTO_SUBMITTED") ? 1 : 0;
  signals.noReplyStyleMessages += message.cleanupSignals.includes("NOREPLY_STYLE_SENDER") ? 1 : 0;
  signals.oldMessages += message.ageBand === "old" || message.ageBand === "very_old" ? 1 : 0;
  signals.veryOldMessages += message.ageBand === "very_old" ? 1 : 0;
  signals.unreadMessages += message.isRead ? 0 : 1;

  if (!message.eligibleForCleanup) return;
  const readySignals = bucket.diagnostics.preliminaryReadyStrongSignals;
  readySignals.listIdMessages += message.listId ? 1 : 0;
  readySignals.listUnsubscribeMessages += message.hasListUnsubscribe ? 1 : 0;
  readySignals.precedenceBulkOrListMessages += isBulkOrListPrecedence(message.precedence) ? 1 : 0;
  readySignals.promotionsMessages += message.providerCategory === "promotions" ? 1 : 0;
  readySignals.withHardProtectionMessages += message.protectionReasons.length > 0 ? 1 : 0;
  readySignals.withoutStrongSignalMessages += message.cleanupSignals.some((signal) =>
    STRONG_CLEANUP_SIGNALS.has(signal)
  )
    ? 0
    : 1;
}

function buildSenderDiagnostics(
  bucket: SenderBucket,
  cleanupCandidateCount: number
): SenderClassifierDiagnostics {
  const finalReadySignals =
    cleanupCandidateCount > 0
      ? { ...bucket.diagnostics.preliminaryReadyStrongSignals }
      : createReadyStrongSignalDiagnostics();
  return {
    totalMessages: bucket.totalMessages,
    readyMessages: cleanupCandidateCount,
    reviewMessages: getReviewCount(
      bucket.totalMessages,
      cleanupCandidateCount,
      bucket.protectedMessages
    ),
    protectedMessages: bucket.protectedMessages,
    messageSignals: { ...bucket.diagnostics.messageSignals },
    readyStrongSignals: finalReadySignals
  };
}

function createMessageSignalDiagnostics(): SenderClassifierDiagnostics["messageSignals"] {
  return {
    starredMessages: 0,
    importantMessages: 0,
    recentMessages: 0,
    sentMessages: 0,
    draftMessages: 0,
    personalMessages: 0,
    participatedConversationMessages: 0,
    userLabelMessages: 0,
    protectedSenderMessages: 0,
    transactionalSubjectMessages: 0,
    securityAccountSubjectMessages: 0,
    listIdMessages: 0,
    listUnsubscribeMessages: 0,
    precedenceBulkOrListMessages: 0,
    promotionsMessages: 0,
    updatesMessages: 0,
    socialMessages: 0,
    autoSubmittedMessages: 0,
    noReplyStyleMessages: 0,
    oldMessages: 0,
    veryOldMessages: 0,
    unreadMessages: 0
  };
}

function createReadyStrongSignalDiagnostics(): SenderClassifierDiagnostics["readyStrongSignals"] {
  return {
    listIdMessages: 0,
    listUnsubscribeMessages: 0,
    precedenceBulkOrListMessages: 0,
    promotionsMessages: 0,
    withHardProtectionMessages: 0,
    withoutStrongSignalMessages: 0
  };
}

function buildMailboxDiagnostics(
  senders: SenderAggregate[],
  participatedConversationsIndexed: number,
  gmailLabelCategory?: GmailLabelCategoryDiagnostics
): MailboxClassifierDiagnostics {
  const messageSignals = createMessageSignalDiagnostics();
  const readyStrongSignals = createReadyStrongSignalDiagnostics();

  for (const sender of senders) {
    if (!sender.diagnostics) continue;
    addNumericCounts(messageSignals, sender.diagnostics.messageSignals);
    addNumericCounts(readyStrongSignals, sender.diagnostics.readyStrongSignals);
  }

  return {
    messageSignals,
    readyStrongSignals,
    participatedConversationsIndexed,
    gmailLabelCategory
  };
}

function createGmailLabelCategoryDiagnostics(): GmailLabelCategoryDiagnostics {
  return {
    scanCategoryInput: "unavailable_through_imap_labels",
    messagesWithAnyGmailLabels: 0,
    normalizedSystemLabelMessages: { starred: 0, important: 0, sent: 0, draft: 0 },
    observedImapCategoryLabelMessages: { promotions: 0, social: 0, personal: 0, updates: 0 },
    observedProviderCategoryMessages: { promotions: 0, social: 0, personal: 0, updates: 0 },
    messagesWithUserLabels: 0,
    distinctUserLabelsObserved: 0,
    unrecognizedSystemOrCategoryShapedLabels: 0,
    autoSubmittedHeaderPresentMessages: 0,
    autoSubmittedAutomationMessages: 0
  };
}

function updateGmailLabelCategoryDiagnostics(
  diagnostics: GmailLabelCategoryDiagnostics,
  distinctUserLabels: Set<string>,
  message: ClassifiedMessage
) {
  const labels = analyzeGmailLabels(message.providerLabels ?? []);
  diagnostics.messagesWithAnyGmailLabels += labels.hasAnyLabels ? 1 : 0;
  diagnostics.normalizedSystemLabelMessages.starred += labels.systemLabels.has("STARRED") ? 1 : 0;
  diagnostics.normalizedSystemLabelMessages.important += labels.systemLabels.has("IMPORTANT") ? 1 : 0;
  diagnostics.normalizedSystemLabelMessages.sent += labels.systemLabels.has("SENT") ? 1 : 0;
  diagnostics.normalizedSystemLabelMessages.draft += labels.systemLabels.has("DRAFT") ? 1 : 0;
  diagnostics.observedImapCategoryLabelMessages.promotions += labels.categoryLabels.has("PROMOTIONS") ? 1 : 0;
  diagnostics.observedImapCategoryLabelMessages.social += labels.categoryLabels.has("SOCIAL") ? 1 : 0;
  diagnostics.observedImapCategoryLabelMessages.personal += labels.categoryLabels.has("PERSONAL") ? 1 : 0;
  diagnostics.observedImapCategoryLabelMessages.updates += labels.categoryLabels.has("UPDATES") ? 1 : 0;
  diagnostics.observedProviderCategoryMessages.promotions += message.providerCategory === "promotions" ? 1 : 0;
  diagnostics.observedProviderCategoryMessages.social += message.providerCategory === "social" ? 1 : 0;
  diagnostics.observedProviderCategoryMessages.personal += message.providerCategory === "personal" ? 1 : 0;
  diagnostics.observedProviderCategoryMessages.updates += message.providerCategory === "updates" ? 1 : 0;
  diagnostics.messagesWithUserLabels += labels.userLabels.length > 0 ? 1 : 0;
  labels.userLabels.forEach((label) => distinctUserLabels.add(label));
  diagnostics.unrecognizedSystemOrCategoryShapedLabels += labels.unrecognizedSystemOrCategoryShapedLabels;
  diagnostics.autoSubmittedHeaderPresentMessages += message.autoSubmitted ? 1 : 0;
  diagnostics.autoSubmittedAutomationMessages += message.cleanupSignals.includes("AUTO_SUBMITTED") ? 1 : 0;
}

function addNumericCounts<T extends object>(target: T, source: T) {
  for (const key of Object.keys(target) as Array<keyof T>) {
    target[key] = ((target[key] as number) + (source[key] as number)) as T[keyof T];
  }
}

function isBulkOrListPrecedence(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "bulk" || normalized === "list";
}

function updateCategoryBucket(bucket: SenderBucket, message: ClassifiedMessage, old: boolean) {
  const existing = bucket.categoryBuckets.get(message.category) ?? {
    totalMessages: 0,
    unreadMessages: 0,
    oldMessages: 0,
    protectedMessages: 0,
    preliminarilyEligibleMessages: 0,
    estimatedBytes: 0,
    preliminarilyEligibleBytes: 0
  };
  existing.totalMessages += 1;
  existing.unreadMessages += message.isRead ? 0 : 1;
  existing.oldMessages += old ? 1 : 0;
  existing.protectedMessages += message.isProtected ? 1 : 0;
  existing.preliminarilyEligibleMessages += message.eligibleForCleanup ? 1 : 0;
  existing.estimatedBytes += message.estimatedSize ?? 0;
  existing.preliminarilyEligibleBytes += message.eligibleForCleanup ? (message.estimatedSize ?? 0) : 0;
  bucket.categoryBuckets.set(message.category, existing);
}

function createCategoryAggregate(category: MailCategory): CategoryAggregate {
  return {
    category,
    totalMessages: 0,
    unreadMessages: 0,
    oldMessages: 0,
    protectedMessages: 0,
    reviewMessages: 0,
    cleanupCandidateCount: 0,
    estimatedBytes: 0,
    estimatedEligibleBytes: 0,
    topRecommendation: "keep"
  };
}

function mostCommonCategory(counts: Map<MailCategory, number>): MailCategory {
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UNKNOWN";
}

function uniqueReasons(reasons: CleanupReason[]): CleanupReason[] {
  return [...new Set(reasons)];
}

function getReviewCount(total: number, ready: number, protectedCount: number): number {
  const review = total - ready - protectedCount;
  if (review < 0) {
    throw new Error("Invalid report buckets: Ready and Protected exceed Total.");
  }
  return review;
}

function orderReasons(reasons: CleanupReason[], recommendation: CleanupRecommendation): CleanupReason[] {
  const priority: CleanupReason[] =
    recommendation === "high" || recommendation === "very_high"
      ? [
          "MULTIPLE_STRONG_BULK_SIGNALS",
          "HAS_LIST_ID",
          "HAS_LIST_UNSUBSCRIBE",
          "PRECEDENCE_BULK",
          "PRECEDENCE_LIST",
          "CATEGORY_PROMOTIONS",
          "RECURRING_SENDER",
          "PREDOMINANTLY_VERY_OLD",
          "PREDOMINANTLY_OLD",
          "SUBSTANTIAL_ELIGIBLE_VOLUME"
        ]
      : [
          "SIGNIFICANT_PROTECTED_SUBSET",
          "USER_LABEL_PRESENT",
          "TRANSACTIONAL_OR_ACCOUNT_LIKE",
          "UNKNOWN_MAIL_TYPE",
          "INSUFFICIENT_BULK_EVIDENCE",
          "CATEGORY_SOCIAL",
          "AUTO_SUBMITTED",
          "NOREPLY_STYLE_SENDER"
        ];
  const rank = new Map(priority.map((reason, index) => [reason, index]));
  return [...reasons].sort((a, b) => (rank.get(a) ?? priority.length) - (rank.get(b) ?? priority.length));
}
