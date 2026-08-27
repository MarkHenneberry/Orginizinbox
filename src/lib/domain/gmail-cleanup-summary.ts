import type { GmailCleanupExclusionCounts } from "@/lib/providers/gmail/cleanup-candidates";
import {
  createGmailProviderErrorCounts,
  type GmailProviderErrorCounts,
  type GmailProviderErrorReason
} from "@/lib/providers/gmail/api-error-classification";
import type { GmailRequestProfile } from "@/lib/providers/gmail/gmail-api-client";
import type {
  GmailSenderGroupFailureCounts,
  GmailSenderGroupFailureReason
} from "@/lib/providers/gmail/group-resolution";
import { estimateGmailCleanupQuota } from "@/lib/providers/gmail/quota";

export type GmailCleanupJobStatus =
  | "ready"
  | "benchmark_complete"
  | "insufficient"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "undoing"
  | "undone"
  | "undo_partial"
  | "undo_failed";

export type GmailCleanupDiagnosticResult =
  | "READY_FOR_CONFIRMATION"
  | "BENCHMARK_COMPLETE"
  | "INSUFFICIENT_SAFE_CANDIDATES"
  | "CANDIDATE_RESOLUTION_FAILED"
  | "SUCCESS"
  | "BATCH_MUTATION_FAILED"
  | "VERIFICATION_PARTIAL"
  | "VERIFICATION_FAILED"
  | "UNDO_SUCCESS"
  | "UNDO_PARTIAL"
  | "UNDO_FAILED";

export type GmailCleanupOperationState = "not_started" | "in_progress" | "completed" | "partial" | "failed";

export type GmailCleanupOperationStates = {
  resolution: GmailCleanupOperationState;
  trashMutation: GmailCleanupOperationState;
  trashVerification: GmailCleanupOperationState;
  undo: GmailCleanupOperationState;
};

export type GmailCleanupDuplicateSubmissionCounts = {
  resolution: number;
  trash: number;
  undo: number;
  scan: number;
};

export type GmailCleanupJobView = {
  id: string;
  status: GmailCleanupJobStatus;
  diagnosticResult: GmailCleanupDiagnosticResult;
  groupDisplayName: string;
  groupSecondaryLabel: string;
  criteria: string;
  requestedCount: number;
  reportReadyCount: number;
  resolvedCount: number;
  excludedMessageCount: number;
  exclusionCounts: GmailCleanupExclusionCounts;
  eligibleSenderGroupCount: number;
  selectedSenderGroupCount: number;
  eligibleSelectedSenderGroupCount: number;
  selectedReadyCount: number;
  selectedReviewExcludedCount: number;
  selectedProtectedExcludedCount: number;
  contributingSenderGroupCount: number;
  largestContribution: number;
  smallestContribution: number;
  senderGroupResolution: {
    selectedCount: number;
    attemptedCount: number;
    successfulCount: number;
    failedCount: number;
    zeroSafeCandidateCount: number;
    contributingCount: number;
    globalFailure: boolean;
    failureReasonCounts: GmailSenderGroupFailureCounts;
    providerFailureReasonCounts?: GmailProviderErrorCounts;
    localFailureCount?: number;
    globalProviderFailureCount?: number;
    globalApplicationFailureCount?: number;
    terminalGlobalApplicationFailureCount?: number;
    classifiedFailureCount?: number;
    failureAccountingInvariant?: boolean;
    failedGroups: Array<{
      label: string;
      domain?: string;
      reason: GmailSenderGroupFailureReason;
      stage?: "query build" | "messages.list" | "metadata recheck" | "group validation";
      providerReason?: GmailProviderErrorReason;
      httpStatus?: number;
      retryable?: boolean;
      retriesAttempted?: number;
      globalFailure?: boolean;
    }>;
  };
  mutationMethod: "batchModify";
  mutationStarted: boolean;
  benchmarkOnly: boolean;
  batchApiResult: "not_started" | "success" | "failed";
  attemptedCount: number;
  verifiedCount: number;
  failedCount: number;
  uncertainCount: number;
  verifiedTrashCount: number;
  reportMarkedStale: boolean;
  candidateResolutionMs: number;
  previewSafetyCheckMs: number;
  finalSafetyRecheckMs: number;
  batchMutationMs: number;
  verificationMs: number;
  totalCleanupMs: number;
  previewRequestProfile: GmailRequestProfile;
  confirmationRequestProfile: GmailRequestProfile;
  undoRequestProfile: GmailRequestProfile;
  requestProfile: GmailRequestProfile;
  estimatedThousandMessageSafetyMs: number;
  estimatedThousandMessageQuotaUnits: number;
  undoAttemptedCount: number;
  undoVerifiedCount: number;
  undoFailedCount: number;
  undoUncertainCount: number;
  undoFallbackVerificationCount: number;
  untrashMs: number;
  undoVerificationMs: number;
  totalUndoMs: number;
  operationStates: GmailCleanupOperationStates;
  duplicateSubmissionsBlocked: GmailCleanupDuplicateSubmissionCounts;
  undoAvailable: boolean;
  confirmationExpiresAt?: number;
  error?: string;
  expiresAt: number;
  completedAt?: number;
};

export function formatDevelopmentCleanupSummary(job: GmailCleanupJobView, now = Date.now()) {
  const exclusions = job.exclusionCounts;
  const quota = estimateGmailCleanupQuota({
    messageCount: job.requestedCount,
    senderGroupCount: job.contributingSenderGroupCount,
    confirmationLabelChecks: job.confirmationRequestProfile.requests.confirmationLabels,
    undoFallbackVerificationCount: job.undoFallbackVerificationCount
  });
  const requests = job.requestProfile.requests;
  const groupResolution = job.senderGroupResolution;
  const groupFailures = groupResolution.failureReasonCounts;
  const providerFailures = {
    ...createGmailProviderErrorCounts(),
    ...groupResolution.providerFailureReasonCounts
  };
  const terminalGlobalApplicationFailures = groupResolution.terminalGlobalApplicationFailureCount ?? 0;
  const classifiedFailures =
    groupResolution.classifiedFailureCount ??
    (groupResolution.localFailureCount ?? 0) +
      (groupResolution.globalProviderFailureCount ?? 0) +
      (groupResolution.globalApplicationFailureCount ?? 0) +
      terminalGlobalApplicationFailures;
  const failureAccountingInvariant =
    groupResolution.failureAccountingInvariant ??
    (classifiedFailures === groupResolution.failedCount + terminalGlobalApplicationFailures &&
      (!groupResolution.globalFailure ||
        (groupResolution.globalProviderFailureCount ?? 0) +
          (groupResolution.globalApplicationFailureCount ?? 0) +
          terminalGlobalApplicationFailures >
          0));
  const cleanupRequestUnits =
    job.previewRequestProfile.estimatedQuotaUnits + job.confirmationRequestProfile.estimatedQuotaUnits;
  const lines = [
    "ORGANIZINBOX DEV CLEANUP SUMMARY",
    "",
    "Selection",
    line("Eligible sender groups available", job.eligibleSenderGroupCount),
    line("Selected sender groups", job.selectedSenderGroupCount),
    line("Eligible selected sender groups", job.eligibleSelectedSenderGroupCount),
    line("Contributing sender groups", job.contributingSenderGroupCount),
    line("Selected Ready", job.selectedReadyCount),
    line("Review excluded", job.selectedReviewExcludedCount),
    line("Protected excluded", job.selectedProtectedExcludedCount),
    line("Largest sender contribution", job.largestContribution),
    line("Smallest sender contribution", job.smallestContribution),
    "",
    "Sender-group outcomes",
    line("Selected", groupResolution.selectedCount),
    line("Attempted", groupResolution.attemptedCount),
    line("Resolved successfully", groupResolution.successfulCount),
    line("Resolved with candidates", groupResolution.contributingCount),
    line("Resolved with zero safe candidates", groupResolution.zeroSafeCandidateCount),
    line("Failed", groupResolution.failedCount),
    `Global failure: ${yesNo(groupResolution.globalFailure)}`,
    "",
    "Failure reasons",
    line("Invalid sender identity", groupFailures.INVALID_SENDER_IDENTITY),
    line("Query build failed", groupFailures.QUERY_BUILD_FAILED),
    line("Provider request failed", groupFailures.PROVIDER_REQUEST_FAILED),
    line("Metadata safety failed", groupFailures.METADATA_RECHECK_FAILED),
    line("Group not in report", groupFailures.GROUP_NOT_IN_REPORT),
    line("Group no longer eligible", groupFailures.GROUP_NO_LONGER_ELIGIBLE),
    line("Other", groupFailures.OTHER_SAFE_ENUM),
    "",
    "Provider failure classification",
    line("Invalid query", providerFailures.GMAIL_INVALID_QUERY),
    line("Authentication", providerFailures.GMAIL_AUTHENTICATION_FAILED),
    line(
      "Permission/domain policy",
      providerFailures.GMAIL_PERMISSION_DENIED + providerFailures.GMAIL_DOMAIN_POLICY
    ),
    line("User rate limited", providerFailures.GMAIL_USER_RATE_LIMITED),
    line("Project rate limited", providerFailures.GMAIL_PROJECT_RATE_LIMITED),
    line("Daily limit", providerFailures.GMAIL_DAILY_LIMIT),
    line("429/concurrency", providerFailures.GMAIL_TOO_MANY_REQUESTS),
    line("Provider 5xx", providerFailures.GMAIL_PROVIDER_5XX),
    line("Network/timeout", providerFailures.GMAIL_NETWORK_ERROR + providerFailures.GMAIL_TIMEOUT),
    line("Not found", providerFailures.GMAIL_NOT_FOUND),
    line("Invalid response", providerFailures.GMAIL_RESPONSE_INVALID),
    line("Other", providerFailures.GMAIL_UNKNOWN_PROVIDER_ERROR),
    line("Local sender failures", groupResolution.localFailureCount ?? 0),
    line("Global provider failures", groupResolution.globalProviderFailureCount ?? 0),
    line("Global application failures", groupResolution.globalApplicationFailureCount ?? 0),
    line("Terminal global application failures", terminalGlobalApplicationFailures),
    line("Classified failures", classifiedFailures),
    `Failure accounting invariant: ${failureAccountingInvariant ? "PASS" : "FAIL"}`,
    "",
    "Validation",
    line("Requested", job.requestedCount),
    line("Report Ready", job.reportReadyCount),
    line("Resolved now", job.resolvedCount),
    line("Excluded during safety checks", job.excludedMessageCount),
    "",
    "Operation states",
    `Resolution: ${operationState(job.operationStates.resolution)}`,
    `Trash mutation: ${operationState(job.operationStates.trashMutation)}`,
    `Trash verification: ${operationState(job.operationStates.trashVerification)}`,
    `Undo: ${operationState(job.operationStates.undo)}`,
    "",
    "Duplicate submissions blocked",
    line("Resolution", job.duplicateSubmissionsBlocked.resolution),
    line("Trash", job.duplicateSubmissionsBlocked.trash),
    line("Undo", job.duplicateSubmissionsBlocked.undo),
    line("Scan", job.duplicateSubmissionsBlocked.scan),
    "",
    "Final recheck exclusions",
    line("Starred", exclusions.STARRED),
    line("Important", exclusions.IMPORTANT),
    line("Recent", exclusions.RECENT),
    line("Sent", exclusions.SENT),
    line("Draft", exclusions.DRAFT),
    line("Personal/Primary category", exclusions.PERSONAL_CATEGORY),
    line("Protected subject", exclusions.PROTECTED_SUBJECT),
    line("Participated conversation", exclusions.PARTICIPATED_CONVERSATION),
    line("Strong bulk evidence missing", exclusions.STRONG_EVIDENCE_MISSING),
    line("Sender mismatch", exclusions.SENDER_MISMATCH),
    line("Already in Trash", exclusions.ALREADY_TRASH),
    line("Protected sender", exclusions.PROTECTED_SENDER),
    line("Other", exclusions.OTHER),
    "",
    "Provider requests",
    line("List", requests.list),
    line("Preview metadata", requests.previewMetadata),
    line("Confirmation label checks", requests.confirmationLabels),
    line("Batch modify", requests.batchModify),
    line("Verification label checks", requests.verificationLabels),
    line("Untrash", requests.untrash),
    line("Undo fallback label checks", requests.undoFallbackLabels),
    line("Retries", job.requestProfile.retryCount),
    line("Peak concurrency", job.requestProfile.peakConcurrency),
    milliseconds("Request p50", job.requestProfile.durationP50Ms),
    milliseconds("Request p95", job.requestProfile.durationP95Ms),
    "",
    "Quota accounting",
    line("Observed units consumed", job.requestProfile.estimatedQuotaUnits),
    line("Projected preview units if completed", quota.preview),
    line("Projected confirmation units if completed", quota.confirmation),
    line("Projected mutation units if completed", quota.mutation),
    line("Projected verification units if completed", quota.verification),
    line("Projected before Undo if completed", quota.beforeUndo),
    line("Estimated 1,000-message before Undo", job.estimatedThousandMessageQuotaUnits),
    "",
    "Mutation",
    "Method: batchModify",
    `Benchmark only: ${yesNo(job.benchmarkOnly)}`,
    `Mutation started: ${yesNo(job.mutationStarted)}`,
    line("Attempted", job.attemptedCount),
    `Batch API result: ${job.batchApiResult}`,
    "",
    "Verification",
    line("Verified in Trash", job.verifiedTrashCount),
    line("Failed", job.failedCount),
    line("Uncertain", job.uncertainCount),
    "",
    "Accounting",
    `Attempted = Verified + Failed + Uncertain: ${accounting(
      job.attemptedCount,
      job.verifiedCount,
      job.failedCount,
      job.uncertainCount
    )}`,
    "",
    "Performance",
    milliseconds("Candidate resolution", job.candidateResolutionMs),
    milliseconds("Full preview safety", job.previewSafetyCheckMs),
    milliseconds("Confirmation safety recheck", job.finalSafetyRecheckMs),
    milliseconds("Batch mutation", job.batchMutationMs),
    milliseconds("Verification", job.verificationMs),
    milliseconds("Total cleanup", job.totalCleanupMs),
    milliseconds("Estimated 1,000-message safety", job.estimatedThousandMessageSafetyMs),
    "",
    "Report",
    `Marked stale: ${yesNo(job.reportMarkedStale)}`,
    "",
    "Undo",
    `Available: ${yesNo(job.undoAvailable)}`,
    `Expires in: ${formatExpiry(job.expiresAt, now)}`
  ];

  if (groupResolution.failedGroups.length > 0) {
    lines.splice(
      lines.indexOf("Validation"),
      0,
      "Failed groups",
      ...groupResolution.failedGroups.flatMap((group) => [
        group.label + (group.domain ? ` (${group.domain})` : ""),
        `Stage: ${group.stage ?? "group validation"}`,
        `Reason: ${group.providerReason ?? group.reason}`,
        `HTTP status: ${group.httpStatus ?? "not available"}`,
        `Retryable: ${yesNo(group.retryable ?? false)}`,
        line("Retries attempted", group.retriesAttempted ?? 0),
        `Failure scope: ${group.globalFailure ? "global" : "local"}`,
        ""
      ]),
      ""
    );
  }

  if (job.undoAttemptedCount > 0 || job.status.startsWith("undo") || job.status === "undone") {
    lines.push(
      line("Attempted restore", job.undoAttemptedCount),
      line("Verified restored", job.undoVerifiedCount),
      line("Failed", job.undoFailedCount),
      line("Uncertain", job.undoUncertainCount),
      `Undo accounting: ${accounting(
        job.undoAttemptedCount,
        job.undoVerifiedCount,
        job.undoFailedCount,
        job.undoUncertainCount
      )}`,
      milliseconds("Untrash", job.untrashMs),
      line("Fallback verification reads", job.undoFallbackVerificationCount),
      milliseconds("Fallback verification", job.undoVerificationMs),
      milliseconds("Total Undo", job.totalUndoMs),
      `Report remains stale: ${yesNo(job.reportMarkedStale)}`,
      "",
      "Undo provider requests",
      line("Untrash", job.undoRequestProfile.requests.untrash),
      line("Fallback verification reads", job.undoRequestProfile.requests.undoFallbackLabels),
      line("Retries", job.undoRequestProfile.retryCount),
      "",
      "Undo quota",
      line("Observed units", job.undoRequestProfile.estimatedQuotaUnits),
      line("Expected units", quota.undo),
      line("Expected response-only units", job.undoAttemptedCount * 5),
      "",
      "Full lifecycle quota",
      line("Cleanup units", cleanupRequestUnits),
      line("Undo units", job.undoRequestProfile.estimatedQuotaUnits),
      line("Total observed units", job.requestProfile.estimatedQuotaUnits),
      "Quota budget reference: 6,000 units/user/minute"
    );
  }

  lines.push(
    "",
    "Result",
    job.diagnosticResult,
    "",
    "Safety audit",
    "Permanent delete API used: no",
    "Body fetched: no",
    "Snippet fetched: no",
    "Attachment data fetched: no",
    "Raw Subject persisted: no",
    "Gmail IDs persisted: no"
  );
  return lines.join("\n");
}

function line(label: string, value: number) {
  return `${label}: ${value.toLocaleString("en-US")}`;
}

function milliseconds(label: string, value: number) {
  return `${label}: ${value.toLocaleString("en-US")} ms`;
}

function yesNo(value: boolean) {
  return value ? "yes" : "no";
}

function operationState(value: GmailCleanupOperationState) {
  return value.replace("_", " ");
}

function accounting(attempted: number, verified: number, failed: number, uncertain: number) {
  return attempted === verified + failed + uncertain ? "PASS" : "FAIL";
}

function formatExpiry(expiresAt: number, now: number) {
  const remainingMinutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
  return remainingMinutes > 0 ? `${remainingMinutes} minutes` : "expired";
}
