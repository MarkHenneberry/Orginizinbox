export type EmailProviderName = "gmail" | "microsoft";

export type MailCategory =
  | "BULK_NEWSLETTER"
  | "PROMOTIONAL"
  | "SOCIAL_AUTOMATION"
  | "ACCOUNT_OR_TRANSACTIONAL"
  | "PERSONAL"
  | "UNKNOWN";

export type ProviderCategory = "promotions" | "social" | "updates" | "personal";

export type SubjectProtection = "transactional" | "security_account";

export type AgeBand = "recent" | "current" | "old" | "very_old";

export type ProtectionReason =
  | "PROTECTED_STARRED"
  | "PROTECTED_IMPORTANT"
  | "PROTECTED_RECENT"
  | "PROTECTED_USER_PARTICIPATED_CONVERSATION"
  | "PROTECTED_PERSONAL"
  | "PROTECTED_SENT"
  | "PROTECTED_DRAFT"
  | "PROTECTED_SENDER"
  | "PROTECTED_TRANSACTIONAL_SUBJECT"
  | "PROTECTED_SECURITY_ACCOUNT_SUBJECT";

export type ReviewSignal =
  | "USER_LABEL_PRESENT"
  | "TRANSACTIONAL_OR_ACCOUNT_LIKE"
  | "UNKNOWN_MAIL_TYPE";

export type CleanupSignal =
  | "HAS_LIST_ID"
  | "HAS_LIST_UNSUBSCRIBE"
  | "PRECEDENCE_BULK"
  | "PRECEDENCE_LIST"
  | "CATEGORY_PROMOTIONS"
  | "CATEGORY_SOCIAL"
  | "AUTO_SUBMITTED"
  | "NOREPLY_STYLE_SENDER"
  | "RECURRING_SENDER"
  | "MOSTLY_UNREAD"
  | "OLD_MAIL"
  | "VERY_OLD_MAIL";

export type CleanupReason =
  | CleanupSignal
  | ReviewSignal
  | ProtectionReason
  | "MULTIPLE_STRONG_BULK_SIGNALS"
  | "SUBSTANTIAL_ELIGIBLE_VOLUME"
  | "PREDOMINANTLY_OLD"
  | "PREDOMINANTLY_VERY_OLD"
  | "SIGNIFICANT_PROTECTED_SUBSET"
  | "INSUFFICIENT_BULK_EVIDENCE";

export type CleanupRecommendation = "very_high" | "high" | "review" | "keep";

export type NormalizedMailboxRecord = {
  providerMessageId: string;
  provider: EmailProviderName;
  senderAddress: string;
  senderDisplayName?: string;
  senderDomain?: string;
  receivedAt: Date;
  isRead: boolean;
  estimatedSize?: number;
  providerLabels?: string[];
  userLabels?: string[];
  providerCategory?: ProviderCategory;
  hasListUnsubscribe?: boolean;
  listId?: string;
  autoSubmitted?: string;
  precedence?: string;
  isStarred?: boolean;
  isImportant?: boolean;
  isSent?: boolean;
  isDraft?: boolean;
  conversationId?: string;
  subjectProtection?: SubjectProtection;
};

export type NormalizedMessageMetadata = NormalizedMailboxRecord;

export type MessageEligibility = {
  eligibleForCleanup: boolean;
  protectionReasons: ProtectionReason[];
  reviewSignals: ReviewSignal[];
  cleanupSignals: CleanupSignal[];
  mailClass: MailCategory;
  ageBand: AgeBand;
};

export type ClassifiedMessage = NormalizedMailboxRecord &
  MessageEligibility & {
    category: MailCategory;
    isProtected: boolean;
  };

export type SenderClassifierDiagnostics = {
  totalMessages: number;
  readyMessages: number;
  reviewMessages: number;
  protectedMessages: number;
  messageSignals: {
    starredMessages: number;
    importantMessages: number;
    recentMessages: number;
    sentMessages: number;
    draftMessages: number;
    personalMessages: number;
    participatedConversationMessages: number;
    userLabelMessages: number;
    protectedSenderMessages: number;
    transactionalSubjectMessages: number;
    securityAccountSubjectMessages: number;
    listIdMessages: number;
    listUnsubscribeMessages: number;
    precedenceBulkOrListMessages: number;
    promotionsMessages: number;
    updatesMessages: number;
    socialMessages: number;
    autoSubmittedMessages: number;
    noReplyStyleMessages: number;
    oldMessages: number;
    veryOldMessages: number;
    unreadMessages: number;
  };
  readyStrongSignals: {
    listIdMessages: number;
    listUnsubscribeMessages: number;
    precedenceBulkOrListMessages: number;
    promotionsMessages: number;
    withHardProtectionMessages: number;
    withoutStrongSignalMessages: number;
  };
};

export type MailboxClassifierDiagnostics = {
  messageSignals: SenderClassifierDiagnostics["messageSignals"];
  readyStrongSignals: SenderClassifierDiagnostics["readyStrongSignals"];
  participatedConversationsIndexed: number;
  gmailLabelCategory?: GmailLabelCategoryDiagnostics;
};

export type GmailLabelCategoryDiagnostics = {
  scanCategoryInput: "unavailable_through_imap_labels";
  messagesWithAnyGmailLabels: number;
  normalizedSystemLabelMessages: {
    starred: number;
    important: number;
    sent: number;
    draft: number;
  };
  observedImapCategoryLabelMessages: {
    promotions: number;
    social: number;
    personal: number;
    updates: number;
  };
  observedProviderCategoryMessages: {
    promotions: number;
    social: number;
    personal: number;
    updates: number;
  };
  messagesWithUserLabels: number;
  distinctUserLabelsObserved: number;
  unrecognizedSystemOrCategoryShapedLabels: number;
  autoSubmittedHeaderPresentMessages: number;
  autoSubmittedAutomationMessages: number;
};

export type ClassifierScanPerformance = {
  conversationIndexMs?: number;
  metadataMs?: number;
  subjectProtectionMs?: number;
  protectionClassificationMs?: number;
  aggregationMs?: number;
  durationMs?: number;
};

export type SenderAggregate = {
  senderKey: string;
  senderSecondaryLabel?: string;
  diagnosticSenderIdentity?: string;
  displayName: string;
  domain?: string;
  totalMessages: number;
  unreadMessages: number;
  readMessages: number;
  unreadRatio: number;
  oldMessages: number;
  veryOldMessages: number;
  recentMessages: number;
  protectedMessages: number;
  reviewMessages: number;
  cleanupCandidateCount: number;
  oldestMessageAt: Date;
  newestMessageAt: Date;
  estimatedBytes: number;
  estimatedEligibleBytes: number;
  recurring: boolean;
  classification: MailCategory;
  cleanupConfidence: CleanupRecommendation;
  reasonCodes: CleanupReason[];
  protectionReasons: ProtectionReason[];
  diagnostics?: SenderClassifierDiagnostics;
};

export type ReportSource = "fixture" | "gmail-live" | "microsoft-live";

export type CategoryAggregate = {
  category: MailCategory;
  totalMessages: number;
  unreadMessages: number;
  oldMessages: number;
  protectedMessages: number;
  reviewMessages: number;
  cleanupCandidateCount: number;
  estimatedBytes: number;
  estimatedEligibleBytes: number;
  topRecommendation: CleanupRecommendation;
};

export type InboxReport = {
  generatedAt: Date;
  provider: EmailProviderName;
  fixtureMode: boolean;
  totals: {
    messages: number;
    cleanupCandidates: number;
    unreadOlderThanOneYear: number;
    recurringSenders: number;
    protectedMessages: number;
    reviewMessages: number;
    estimatedRecoverableBytes: number;
  };
  senders: SenderAggregate[];
  categories: CategoryAggregate[];
  classifierDiagnostics?: MailboxClassifierDiagnostics;
};
