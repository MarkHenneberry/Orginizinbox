import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatDevelopmentCleanupSummary,
  type GmailCleanupJobView
} from "@/lib/domain/gmail-cleanup-summary";
import { createGmailProviderErrorCounts } from "@/lib/providers/gmail/api-error-classification";
import { createGmailCleanupExclusionCounts } from "@/lib/providers/gmail/cleanup-candidates";
import { createGmailRequestCounts } from "@/lib/providers/gmail/quota";
import { createGmailSenderGroupFailureCounts } from "@/lib/providers/gmail/group-resolution";

function requestProfile(overrides: Partial<GmailCleanupJobView["requestProfile"]> = {}): GmailCleanupJobView["requestProfile"] {
  return {
    requestCount: 0,
    retryCount: 0,
    peakConcurrency: 0,
    durationP50Ms: 0,
    durationP95Ms: 0,
    estimatedQuotaUnits: 0,
    requests: createGmailRequestCounts(),
    ...overrides
  };
}

function cleanupJob(overrides: Partial<GmailCleanupJobView> = {}): GmailCleanupJobView {
  return {
    id: "private-cleanup-job-id",
    status: "completed",
    diagnosticResult: "SUCCESS",
    groupDisplayName: "Visible sender",
    groupSecondaryLabel: "example.test",
    criteria: "safe criteria",
    requestedCount: 100,
    reportReadyCount: 184,
    resolvedCount: 100,
    excludedMessageCount: 7,
    exclusionCounts: { ...createGmailCleanupExclusionCounts(), STARRED: 1, IMPORTANT: 2, PROTECTED_SUBJECT: 2 },
    eligibleSenderGroupCount: 8,
    selectedSenderGroupCount: 4,
    eligibleSelectedSenderGroupCount: 4,
    selectedReadyCount: 184,
    selectedReviewExcludedCount: 30,
    selectedProtectedExcludedCount: 25,
    contributingSenderGroupCount: 3,
    largestContribution: 34,
    smallestContribution: 33,
    senderGroupResolution: {
      selectedCount: 4,
      attemptedCount: 4,
      successfulCount: 4,
      failedCount: 0,
      zeroSafeCandidateCount: 0,
      contributingCount: 3,
      globalFailure: false,
      failureReasonCounts: createGmailSenderGroupFailureCounts(),
      failedGroups: []
    },
    mutationMethod: "batchModify",
    mutationStarted: true,
    benchmarkOnly: false,
    batchApiResult: "success",
    attemptedCount: 100,
    verifiedCount: 100,
    failedCount: 0,
    uncertainCount: 0,
    verifiedTrashCount: 100,
    reportMarkedStale: true,
    candidateResolutionMs: 25,
    previewSafetyCheckMs: 400,
    finalSafetyRecheckMs: 500,
    batchMutationMs: 120,
    verificationMs: 800,
    totalCleanupMs: 1445,
    previewRequestProfile: requestProfile({
      requestCount: 103,
      peakConcurrency: 8,
      estimatedQuotaUnits: 2015,
      requests: { ...createGmailRequestCounts(), list: 3, previewMetadata: 100 }
    }),
    confirmationRequestProfile: requestProfile({
      requestCount: 104,
      peakConcurrency: 8,
      estimatedQuotaUnits: 2075,
      requests: { ...createGmailRequestCounts(), list: 3, batchModify: 1, verificationLabels: 100 }
    }),
    undoRequestProfile: requestProfile(),
    requestProfile: requestProfile({
      requestCount: 207,
      peakConcurrency: 8,
      durationP50Ms: 120,
      durationP95Ms: 210,
      estimatedQuotaUnits: 4090,
      requests: { ...createGmailRequestCounts(), list: 6, previewMetadata: 100, batchModify: 1, verificationLabels: 100 }
    }),
    estimatedThousandMessageSafetyMs: 9000,
    estimatedThousandMessageQuotaUnits: 40_080,
    undoAttemptedCount: 0,
    undoVerifiedCount: 0,
    undoFailedCount: 0,
    undoUncertainCount: 0,
    undoFallbackVerificationCount: 0,
    untrashMs: 0,
    undoVerificationMs: 0,
    totalUndoMs: 0,
    operationStates: {
      resolution: "completed",
      trashMutation: "completed",
      trashVerification: "completed",
      undo: "not_started"
    },
    duplicateSubmissionsBlocked: {
      resolution: 0,
      trash: 0,
      undo: 0,
      scan: 0
    },
    suggestedDeltas: [],
    bulkUndoProofDuplicateSubmissions: 0,
    undoAvailable: true,
    expiresAt: Date.parse("2026-08-26T12:10:00Z"),
    completedAt: Date.parse("2026-08-26T12:01:00Z"),
    ...overrides
  };
}

describe("development cleanup summary", () => {
  it("includes validation, exclusions, mutation, verification, timing, stale-report, and accounting fields", () => {
    const output = formatDevelopmentCleanupSummary(cleanupJob(), Date.parse("2026-08-26T12:05:00Z"));

    expect(output).toContain("ORGANIZINBOX DEV CLEANUP SUMMARY");
    expect(output).toContain("Requested: 100");
    expect(output).toContain("Eligible sender groups available: 8");
    expect(output).toContain("Selected sender groups: 4");
    expect(output).toContain("Contributing sender groups: 3");
    expect(output).toContain("Sender-group outcomes");
    expect(output).toContain("Resolved successfully: 4");
    expect(output).toContain("Report Suggested: 184");
    expect(output).toContain("Session Suggested adjustments");
    expect(output).toContain("Verified moved: 0");
    expect(output).toContain("Resolved now: 100");
    expect(output).toContain("Protected subject: 2");
    expect(output).toContain("Method: batchModify");
    expect(output).toContain("Verified in Trash: 100");
    expect(output).toContain("Attempted = Verified + Failed + Uncertain: PASS");
    expect(output).toContain("Candidate resolution: 25 ms");
    expect(output).toContain("Full preview safety: 400 ms");
    expect(output).toContain("Confirmation safety recheck: 500 ms");
    expect(output).toContain("Preview metadata: 100");
    expect(output).toContain("Peak concurrency: 8");
    expect(output).toContain("Observed units consumed: 4,090");
    expect(output).toContain("Estimated 1,000-message before Undo: 40,080");
    expect(output).toContain("Marked stale: yes");
    expect(output).toContain("Operation states");
    expect(output).toContain("Trash mutation: completed");
    expect(output).toContain("Trash verification: completed");
    expect(output).toContain("Duplicate submissions blocked");
    expect(output).toContain("SUCCESS");
  });

  it("reports safe aggregate operation states and duplicate blocks", () => {
    const output = formatDevelopmentCleanupSummary(
      cleanupJob({
        operationStates: {
          resolution: "completed",
          trashMutation: "completed",
          trashVerification: "completed",
          undo: "completed"
        },
        duplicateSubmissionsBlocked: {
          resolution: 2,
          trash: 1,
          undo: 1,
          scan: 3
        }
      })
    );

    expect(output).toContain("Resolution: completed");
    expect(output).toContain("Trash mutation: completed");
    expect(output).toContain("Trash verification: completed");
    expect(output).toContain("Undo: completed");
    expect(output).toContain("Resolution: 2");
    expect(output).toContain("Trash: 1");
    expect(output).toContain("Undo: 1");
    expect(output).toContain("Scan: 3");
    expect(output).not.toContain("private-cleanup-job-id");
  });

  it("represents insufficient and partial states without claiming success", () => {
    const insufficient = formatDevelopmentCleanupSummary(
      cleanupJob({
        status: "insufficient",
        diagnosticResult: "INSUFFICIENT_SAFE_CANDIDATES",
        resolvedCount: 97,
        mutationStarted: false,
        batchApiResult: "not_started",
        attemptedCount: 0,
        verifiedCount: 0,
        verifiedTrashCount: 0,
        undoAvailable: false,
        reportMarkedStale: false
      })
    );
    const partial = formatDevelopmentCleanupSummary(
      cleanupJob({
        status: "partial",
        diagnosticResult: "VERIFICATION_PARTIAL",
        verifiedCount: 98,
        verifiedTrashCount: 98,
        uncertainCount: 2,
        undoAvailable: false
      })
    );

    expect(insufficient).toContain("Mutation started: no");
    expect(insufficient).toContain("INSUFFICIENT_SAFE_CANDIDATES");
    expect(partial).toContain("Verified in Trash: 98");
    expect(partial).toContain("Uncertain: 2");
    expect(partial).toContain("VERIFICATION_PARTIAL");
  });

  it("preserves local group failures, partial timing, provider work, and projected quota distinctions", () => {
    const failureReasons = createGmailSenderGroupFailureCounts();
    failureReasons.PROVIDER_REQUEST_FAILED = 1;
    const providerFailureReasons = createGmailProviderErrorCounts();
    providerFailureReasons.GMAIL_RESPONSE_INVALID = 1;
    const output = formatDevelopmentCleanupSummary(
      cleanupJob({
        status: "insufficient",
        diagnosticResult: "INSUFFICIENT_SAFE_CANDIDATES",
        resolvedCount: 87,
        contributingSenderGroupCount: 42,
        candidateResolutionMs: 410,
        previewSafetyCheckMs: 2200,
        totalCleanupMs: 2746,
        senderGroupResolution: {
          selectedCount: 43,
          attemptedCount: 43,
          successfulCount: 42,
          failedCount: 1,
          zeroSafeCandidateCount: 0,
          contributingCount: 42,
          globalFailure: false,
          failureReasonCounts: failureReasons,
          providerFailureReasonCounts: providerFailureReasons,
          localFailureCount: 1,
          globalProviderFailureCount: 0,
          failedGroups: [
            {
              label: "Encoded sender",
              domain: "example.test",
              reason: "PROVIDER_REQUEST_FAILED",
              stage: "messages.list",
              providerReason: "GMAIL_RESPONSE_INVALID",
              httpStatus: 200,
              retryable: false,
              retriesAttempted: 0,
              globalFailure: false
            }
          ]
        },
        previewRequestProfile: requestProfile({
          requestCount: 121,
          estimatedQuotaUnits: 1835,
          requests: { ...createGmailRequestCounts(), list: 39, previewMetadata: 82 }
        }),
        confirmationRequestProfile: requestProfile(),
        requestProfile: requestProfile({
          requestCount: 121,
          estimatedQuotaUnits: 1835,
          requests: { ...createGmailRequestCounts(), list: 39, previewMetadata: 82 }
        }),
        mutationStarted: false,
        attemptedCount: 0,
        verifiedCount: 0,
        verifiedTrashCount: 0,
        undoAvailable: false
      })
    );

    expect(output).toContain("Sender-group outcomes");
    expect(output).toContain("Selected: 43");
    expect(output).toContain("Attempted: 43");
    expect(output).toContain("Resolved successfully: 42");
    expect(output).toContain("Failed: 1");
    expect(output).toContain("Resolved with candidates: 42");
    expect(output).toContain("Provider request failed: 1");
    expect(output).toContain("Provider failure classification");
    expect(output).toContain("Invalid response: 1");
    expect(output).toContain("Local sender failures: 1");
    expect(output).toContain("Global provider failures: 0");
    expect(output).toContain("Classified failures: 1");
    expect(output).toContain("Failure accounting invariant: PASS");
    expect(output).toContain("Encoded sender (example.test)");
    expect(output).toContain("Stage: messages.list");
    expect(output).toContain("Reason: GMAIL_RESPONSE_INVALID");
    expect(output).toContain("HTTP status: 200");
    expect(output).toContain("Retryable: no");
    expect(output).toContain("Retries attempted: 0");
    expect(output).toContain("Candidate resolution: 410 ms");
    expect(output).toContain("Full preview safety: 2,200 ms");
    expect(output).toContain("Total cleanup: 2,746 ms");
    expect(output).toContain("Observed units consumed: 1,835");
    expect(output).toContain("Projected mutation units if completed: 50");
    expect(output).toContain("Mutation started: no");
  });

  it("reports successful zero-candidate groups without provider failures", () => {
    const failureReasons = createGmailSenderGroupFailureCounts();
    failureReasons.NO_SAFE_CANDIDATES = 3;
    const output = formatDevelopmentCleanupSummary(
      cleanupJob({
        senderGroupResolution: {
          selectedCount: 43,
          attemptedCount: 43,
          successfulCount: 43,
          failedCount: 0,
          zeroSafeCandidateCount: 3,
          contributingCount: 40,
          globalFailure: false,
          failureReasonCounts: failureReasons,
          providerFailureReasonCounts: createGmailProviderErrorCounts(),
          localFailureCount: 0,
          globalProviderFailureCount: 0,
          globalApplicationFailureCount: 0,
          terminalGlobalApplicationFailureCount: 0,
          classifiedFailureCount: 0,
          failureAccountingInvariant: true,
          failedGroups: []
        }
      })
    );

    expect(output).toContain("Resolved successfully: 43");
    expect(output).toContain("Failed: 0");
    expect(output).toContain("Resolved with zero safe candidates: 3");
    expect(output).toContain("Resolved with candidates: 40");
    expect(output).toContain("Invalid response: 0");
    expect(output).toContain("Global provider failures: 0");
    expect(output).toContain("Failure accounting invariant: PASS");
    expect(output).not.toContain("HTTP status: 204");
    expect(output).not.toContain("No safe candidates: 3");
  });

  it("flags an unclassified global failure as an accounting violation", () => {
    const output = formatDevelopmentCleanupSummary(
      cleanupJob({
        senderGroupResolution: {
          ...cleanupJob().senderGroupResolution,
          globalFailure: true,
          failedCount: 1,
          localFailureCount: 0,
          globalProviderFailureCount: 0,
          globalApplicationFailureCount: 0,
          terminalGlobalApplicationFailureCount: 0,
          classifiedFailureCount: 0,
          failureAccountingInvariant: false
        }
      })
    );

    expect(output).toContain("Global failure: yes");
    expect(output).toContain("Global provider failures: 0");
    expect(output).toContain("Global application failures: 0");
    expect(output).toContain("Failure accounting invariant: FAIL");
  });

  it("appends response-based Undo accounting and quota diagnostics without overwriting the Trash result", () => {
    const output = formatDevelopmentCleanupSummary(
      cleanupJob({
        status: "undone",
        diagnosticResult: "UNDO_SUCCESS",
        undoAttemptedCount: 100,
        undoVerifiedCount: 100,
        undoFallbackVerificationCount: 2,
        untrashMs: 700,
        undoVerificationMs: 80,
        totalUndoMs: 780,
        undoRequestProfile: requestProfile({
          requestCount: 102,
          retryCount: 1,
          estimatedQuotaUnits: 540,
          requests: { ...createGmailRequestCounts(), untrash: 100, undoFallbackLabels: 2 }
        }),
        requestProfile: requestProfile({
          requestCount: 309,
          retryCount: 1,
          estimatedQuotaUnits: 4630,
          requests: {
            ...createGmailRequestCounts(),
            list: 6,
            previewMetadata: 100,
            batchModify: 1,
            verificationLabels: 100,
            untrash: 100,
            undoFallbackLabels: 2
          }
        }),
        undoAvailable: false
      })
    );

    expect(output).toContain("Verified in Trash: 100");
    expect(output).toContain("Attempted restore: 100");
    expect(output).toContain("Verified restored: 100");
    expect(output).toContain("Undo accounting: PASS");
    expect(output).toContain("Untrash: 100");
    expect(output).toContain("Fallback verification reads: 2");
    expect(output).toContain("Expected response-only units: 500");
    expect(output).toContain("Expected units: 540");
    expect(output).toContain("Cleanup units: 4,090");
    expect(output).toContain("Undo units: 540");
    expect(output).toContain("Total observed units: 4,630");
    expect(output).toContain("Quota budget reference: 6,000 units/user/minute");
    expect(output).toContain("Report remains stale: yes");
  });

  it("excludes identifiers, mailbox content, credentials, queries, and provider responses", () => {
    const output = formatDevelopmentCleanupSummary(
      cleanupJob({ error: "private-provider-response authorization-code raw Subject search-query" })
    );

    for (const sensitive of [
      "private-cleanup-job-id",
      "native-gmail-message-id",
      "thread-id",
      "conversation-id",
      "authorization-code",
      "oauth-token",
      "raw Subject",
      "raw-header",
      "search-query",
      "private-provider-response"
    ]) {
      expect(output).not.toContain(sensitive);
    }
  });

  it("gates the copyable summary with the server-provided development mode", () => {
    const page = readFileSync("app/app/cleanup/page.tsx", "utf8");
    const client = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");

    expect(page).toMatch(/developmentMode=\{process\.env\.NODE_ENV !== "production"\}/);
    expect(client).toMatch(/developmentMode \? <DevelopmentCleanupDetails job=\{job\} \/> : null/);
    expect(client).toContain("Copy cleanup summary");
    expect(client).toContain("Copied");
  });
});
