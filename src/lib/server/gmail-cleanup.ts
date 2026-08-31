import "server-only";
import { runtimeConfig } from "@/lib/config";
import {
  getGmailCleanupRequestMode,
  gmailLegacyCleanupHardMaximum
} from "@/lib/domain/gmail-cleanup-request-mode";
import { mergeCleanupSuggestedDeltas } from "@/lib/domain/cleanup-session-adjustments";
import type { SenderAggregate } from "@/lib/domain/types";
import { createGmailProviderErrorCounts } from "@/lib/providers/gmail/api-error-classification";
import {
  allocateCleanupCountAcrossGroups,
  buildCleanupSenderGroups,
  createGmailCleanupExclusionCounts,
  gmailCleanupAgeThresholdLabel,
  gmailCleanupExclusionReasons,
  normalizeGmailCleanupSenderIdentity,
  type GmailCleanupExclusionCounts
} from "@/lib/providers/gmail/cleanup-candidates";
import {
  GmailApiRequestError,
  GmailCandidateResolutionStageError,
  GmailTrashClient,
  type GmailRequestProfile
} from "@/lib/providers/gmail/gmail-api-client";
import {
  createGmailSenderGroupFailureCounts,
  GmailSenderGroupResolutionError,
  resolveGmailCleanupSenderGroups,
  type GmailSenderGroupProviderFailure,
  type GmailSenderGroupResolutionResult
} from "@/lib/providers/gmail/group-resolution";
import { createGmailRequestCounts, estimateGmailCleanupQuota } from "@/lib/providers/gmail/quota";
import {
  GmailShadowVerifier,
  assertGmailShadowProofInput,
  type GmailShadowVerificationResult
} from "@/lib/providers/gmail/shadow-verifier";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import {
  countVerifiedCandidatesByGroup,
  createBulkUndoRecoveryPlan
} from "@/lib/server/gmail-cleanup-adjustments";
import {
  createGmailCleanupJob,
  getGmailCleanupJob,
  incrementGmailCleanupDuplicateSubmission,
  invalidateGmailCleanupPreview,
  runOrJoinGmailCleanupOperation,
  serializeGmailCleanupJob,
  updateGmailCleanupJob,
  type GmailCleanupJob,
  type GmailCleanupStoredCandidate
} from "@/lib/server/gmail-cleanup-store";
import { getLiveScan, markLiveReportStale } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export const gmailCleanupConfirmation = "MOVE_TO_TRASH";
export const gmailCleanupHardMaximum = gmailLegacyCleanupHardMaximum;

export class GmailCleanupError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "GmailCleanupError";
  }
}

export async function createGmailCleanupPreview(input: {
  groupIndices: number[];
  requestedCount: number;
  benchmarkOnly?: boolean;
}) {
  const session = await requireSession();
  let duplicateCount = 0;
  const operation = runOrJoinGmailCleanupOperation(
    `resolution:${session.userId}`,
    async () => {
      const view = await createGmailCleanupPreviewOperation(input, session.userId);
      const job = getGmailCleanupJob(session.userId, view.id);
      if (!job) return view;
      return serializeGmailCleanupJob(
        updateGmailCleanupJob(job, {
          duplicateSubmissionsBlocked: {
            ...job.duplicateSubmissionsBlocked,
            resolution: duplicateCount
          }
        })
      );
    },
    () => {
      duplicateCount += 1;
    }
  );
  return operation.promise;
}

async function createGmailCleanupPreviewOperation(
  input: { groupIndices: number[]; requestedCount: number; benchmarkOnly?: boolean },
  userId: string
) {
  const context = await assertGmailCleanupContext(input.requestedCount, userId);
  const report = context.liveScan.report;
  if (!report) throw new GmailCleanupError("A completed live Gmail report is required before cleanup.", 409);
  if (context.liveScan.reportStale) {
    throw new GmailCleanupError("This Inbox Report is stale. Run a fresh Gmail scan before cleanup.", 409);
  }

  const groupIndices = parseCleanupGroupIndices(input.groupIndices);
  const publicGroups = buildCleanupSenderGroups(report.senders);
  const selectedGroups = groupIndices.map((index) => publicGroups[index]);
  if (selectedGroups.some((group) => !group?.eligible)) {
    throw new GmailCleanupError("Select only Suggested High or Very High groups from the active Inbox Report.", 400);
  }
  const selectedReadyCount = selectedGroups.reduce((total, group) => total + group.cleanupCandidateCount, 0);
  if (selectedReadyCount < input.requestedCount) {
    throw new GmailCleanupError("The selected senders do not have enough combined Suggested messages for that count.", 400);
  }

  const allocations = allocateCleanupCountAcrossGroups(selectedGroups, input.requestedCount);
  if (allocations.reduce((total, allocation) => total + allocation.requestedCount, 0) !== input.requestedCount) {
    throw new GmailCleanupError("The requested count could not be allocated across the selected senders.", 400);
  }

  const trashClient = createTrashClient(context.connection.accessToken);
  const previewStartedAt = performance.now();
  try {
    const resolution = await resolveGmailCleanupSenderGroups({
      selectedGroups,
      requestedCount: input.requestedCount,
      concurrency: runtimeConfig.gmailCleanupRecheckConcurrency,
      resolveGroup: async (group, limit) => {
        const reportSender = report.senders[group.index];
        if (!reportSender) {
          throw new GmailSenderGroupResolutionError("GROUP_NOT_IN_REPORT", false);
        }
        if (!group.eligible) {
          throw new GmailSenderGroupResolutionError("GROUP_NO_LONGER_ELIGIBLE", false);
        }
        const senderAddress = normalizeGmailCleanupSenderIdentity(reportSender.senderKey);
        if (!senderAddress) {
          throw new GmailSenderGroupResolutionError("INVALID_SENDER_IDENTITY", false);
        }
        try {
          return await trashClient.resolveCleanupCandidatesForSender({
            senderAddress,
            limit,
            participatedConversationIds: context.liveScan.participatedConversationIds
          });
        } catch (error) {
          throw classifySenderGroupResolutionError(error);
        }
      }
    });
    const apiCandidates = resolution.candidates;
    const resolvedCount = apiCandidates.length;
    const ready = !resolution.globalFailure && resolvedCount === input.requestedCount;
    const previewProfile = trashClient.getRequestProfile();
    const status = resolution.globalFailure ? "failed" : ready ? "ready" : "insufficient";
    const diagnosticResult = resolution.globalFailure
      ? "CANDIDATE_RESOLUTION_FAILED"
      : ready
        ? "READY_FOR_CONFIRMATION"
        : "INSUFFICIENT_SAFE_CANDIDATES";
    const resolutionDiagnostics = toSenderGroupResolutionDiagnostics(resolution);

    let job = createGmailCleanupJob({
      ...baseJobFields({
        selectedGroups,
        eligibleSenderGroupCount: publicGroups.filter((group) => group.eligible).length,
        requestedCount: input.requestedCount,
        selectedReadyCount,
        contributions: resolution.contributions,
        senderGroupResolution: resolutionDiagnostics,
        benchmarkOnly: Boolean(input.benchmarkOnly)
      }),
      userId: context.userId,
      scanId: context.liveScan.progress.scanId,
      status,
      diagnosticResult,
      resolvedCount,
      excludedMessageCount: resolution.excludedMessageCount,
      exclusionCounts: resolution.exclusionCounts,
      candidateResolutionMs: resolution.candidateResolutionMs,
      previewSafetyCheckMs: resolution.previewSafetyCheckMs,
      finalSafetyRecheckMs: 0,
      totalCleanupMs: Math.round(performance.now() - previewStartedAt),
      previewRequestProfile: previewProfile,
      confirmationRequestProfile: emptyRequestProfile(),
      undoRequestProfile: emptyRequestProfile(),
      requestProfile: previewProfile,
      estimatedThousandMessageSafetyMs: estimateThousandSafetyMs(
        resolution.previewSafetyCheckMs,
        0,
        resolvedCount
      ),
      estimatedThousandMessageQuotaUnits: estimateThousandQuota(
        Math.max(resolution.contributions.length, 1),
        countMutableCandidates(apiCandidates)
      ),
      groupIndices: [...new Set(apiCandidates.map((candidate) => candidate.groupIndex))],
      apiCandidates,
      operationStates: {
        resolution: "completed",
        trashMutation: "not_started",
        trashVerification: "not_started",
        undo: "not_started"
      },
      duplicateSubmissionsBlocked: {
        resolution: 0,
        trash: 0,
        undo: 0,
        scan: context.liveScan.progress.duplicateStartCount
      },
      error: resolution.globalFailure
        ? "Gmail candidate resolution failed. No messages were moved."
        : ready
          ? undefined
          : resolutionFailureMessage(resolution.failedCount)
    });

    if (ready && input.benchmarkOnly) {
      job = await completeNonMutatingBenchmark(job, report.senders, context.connection.accessToken);
    }
    return serializeGmailCleanupJob(job);
  } catch {
    const failed = createGmailCleanupJob({
      ...baseJobFields({
        selectedGroups,
        eligibleSenderGroupCount: publicGroups.filter((group) => group.eligible).length,
        requestedCount: input.requestedCount,
        selectedReadyCount,
        contributions: [],
        senderGroupResolution: emptySenderGroupResolutionDiagnostics(selectedGroups.length),
        benchmarkOnly: Boolean(input.benchmarkOnly)
      }),
      userId: context.userId,
      scanId: context.liveScan.progress.scanId,
      status: "failed",
      diagnosticResult: "CANDIDATE_RESOLUTION_FAILED",
      resolvedCount: 0,
      excludedMessageCount: 0,
      exclusionCounts: createGmailCleanupExclusionCounts(),
      candidateResolutionMs: Math.round(performance.now() - previewStartedAt),
      previewSafetyCheckMs: 0,
      finalSafetyRecheckMs: 0,
      totalCleanupMs: Math.round(performance.now() - previewStartedAt),
      previewRequestProfile: trashClient.getRequestProfile(),
      confirmationRequestProfile: emptyRequestProfile(),
      undoRequestProfile: emptyRequestProfile(),
      requestProfile: trashClient.getRequestProfile(),
      estimatedThousandMessageSafetyMs: 0,
      estimatedThousandMessageQuotaUnits: estimateThousandQuota(Math.max(allocations.length, 1), 0),
      groupIndices,
      apiCandidates: [],
      operationStates: {
        resolution: "failed",
        trashMutation: "not_started",
        trashVerification: "not_started",
        undo: "not_started"
      },
      duplicateSubmissionsBlocked: {
        resolution: 0,
        trash: 0,
        undo: 0,
        scan: context.liveScan.progress.duplicateStartCount
      },
      error: "Candidate resolution failed. No messages were moved."
    });
    return serializeGmailCleanupJob(failed);
  }
}

export async function confirmGmailCleanup(input: { jobId: string; confirmation: string }) {
  if (input.confirmation !== gmailCleanupConfirmation) {
    throw new GmailCleanupError("Explicit Gmail cleanup confirmation was not provided.", 400);
  }

  const session = await requireSession();
  const job = getGmailCleanupJob(session.userId, input.jobId);
  if (!job) throw new GmailCleanupError("This cleanup check has expired. Start over and check your selection again.", 410);
  if (job.benchmarkOnly) throw new GmailCleanupError("Safety benchmarks cannot start a Gmail mutation.", 409);
  if (job.status === "completed" || job.status === "partial" || (job.status === "failed" && job.mutationStarted)) {
    incrementGmailCleanupDuplicateSubmission(job.id, "trash");
    return serializeGmailCleanupJob(getGmailCleanupJob(session.userId, job.id) ?? job);
  }
  if (job.status === "running") {
    const active = runOrJoinGmailCleanupOperation(
      `trash:${job.id}`,
      async () => serializeGmailCleanupJob(job),
      () => incrementGmailCleanupDuplicateSubmission(job.id, "trash")
    );
    return active.promise;
  }
  if (job.status !== "ready") throw new GmailCleanupError("Cleanup job is not ready for confirmation.", 409);
  if (job.confirmationExpiresAt < Date.now()) {
    throw new GmailCleanupError("This cleanup check has expired. Start over and check your selection again.", 410);
  }
  if (job.resolvedCount !== job.requestedCount || job.apiCandidates.length !== job.requestedCount) {
    throw new GmailCleanupError("The requested safe candidate count was not resolved. Check the messages again.", 409);
  }

  const operation = runOrJoinGmailCleanupOperation(
    `trash:${job.id}`,
    () => performGmailCleanupConfirmation(job, session.userId),
    () => incrementGmailCleanupDuplicateSubmission(job.id, "trash")
  );
  return operation.promise;
}

export async function startOverGmailCleanup(jobId: string) {
  const session = await requireSession();
  const result = invalidateGmailCleanupPreview(session.userId, jobId);
  if (result === "mutation_started" || result === "complete") {
    throw new GmailCleanupError("This cleanup can no longer be started over.", 409);
  }
  return { discarded: true as const };
}

async function performGmailCleanupConfirmation(job: GmailCleanupJob, userId: string) {
  let running = updateGmailCleanupJob(job, {
    status: "running",
    operationStates: {
      ...job.operationStates,
      trashMutation: "in_progress",
      trashVerification: "not_started"
    }
  });
  let context: Awaited<ReturnType<typeof assertGmailCleanupContext>>;
  let reportSenders: SenderAggregate[];
  try {
    context = await assertGmailCleanupContext(job.requestedCount, userId);
    if (context.liveScan.progress.scanId !== job.scanId || context.liveScan.reportStale) {
      throw new GmailCleanupError("The active Inbox Report changed. Run a fresh cleanup preview.", 409);
    }
    const activeReportSenders = context.liveScan.report?.senders;
    if (!activeReportSenders || !selectedGroupsRemainEligible(job, activeReportSenders)) {
      throw new GmailCleanupError("A selected group is no longer eligible. Run a fresh Gmail scan.", 409);
    }
    reportSenders = activeReportSenders;
  } catch (error) {
    updateGmailCleanupJob(running, {
      status: "ready",
      operationStates: {
        ...running.operationStates,
        trashMutation: "not_started",
        trashVerification: "not_started"
      }
    });
    throw error;
  }

  const trashClient = createTrashClient(context.connection.accessToken);
  const recheck = await runConfirmationRecheck(job, reportSenders, trashClient).catch(() => undefined);
  if (!recheck) {
    const failed = updateGmailCleanupJob(running, {
      status: "failed",
      diagnosticResult: "CANDIDATE_RESOLUTION_FAILED",
      operationStates: { ...running.operationStates, trashMutation: "failed" },
      error: "Final safety recheck failed. No messages were moved."
    });
    return serializeGmailCleanupJob(failed);
  }

  const combinedExclusions = mergeExclusionCounts(job.exclusionCounts, recheck.exclusionCounts);
  const eligibleCandidates = job.apiCandidates.filter((candidate) => recheck.eligibleIds.includes(candidate.apiMessageId));
  if (eligibleCandidates.length !== job.requestedCount) {
    const confirmationProfile = trashClient.getRequestProfile();
    const insufficient = updateGmailCleanupJob(running, {
      status: "insufficient",
      diagnosticResult: "INSUFFICIENT_SAFE_CANDIDATES",
      resolvedCount: eligibleCandidates.length,
      excludedMessageCount: job.excludedMessageCount + recheck.excludedMessageCount,
      exclusionCounts: combinedExclusions,
      finalSafetyRecheckMs: recheck.finalSafetyRecheckMs,
      totalCleanupMs: job.totalCleanupMs + recheck.finalSafetyRecheckMs,
      confirmationRequestProfile: confirmationProfile,
      requestProfile: mergeRequestProfiles(job.previewRequestProfile, confirmationProfile),
      apiCandidates: eligibleCandidates,
      operationStates: { ...running.operationStates, trashMutation: "failed" },
      error: "Some messages no longer meet the safety rules. No messages were moved."
    });
    return serializeGmailCleanupJob(insufficient);
  }

  running = updateGmailCleanupJob(running, {
    status: "running",
    finalSafetyRecheckMs: recheck.finalSafetyRecheckMs,
    exclusionCounts: combinedExclusions,
    mutationStarted: true,
    attemptedCount: eligibleCandidates.length
  });
  const eligibleIds = eligibleCandidates.map((candidate) => candidate.apiMessageId);
  const shadow = await prepareHistoryShadow(context.connection.accessToken, eligibleIds);
  const batchStartedAt = performance.now();
  let batchApiResult: "success" | "failed" = "success";
  try {
    await trashClient.batchModifyTrash(eligibleIds);
  } catch {
    batchApiResult = "failed";
  }
  const batchMutationMs = Math.round(performance.now() - batchStartedAt);
  markLiveReportStale(userId);

  running = updateGmailCleanupJob(running, {
    batchApiResult,
    batchMutationMs,
    operationStates: {
      ...running.operationStates,
      trashMutation: batchApiResult === "success" ? "completed" : "failed",
      trashVerification: "in_progress"
    }
  });

  let verification: Awaited<ReturnType<GmailTrashClient["verifyMessagesInTrash"]>>;
  try {
    verification = await trashClient.verifyMessagesInTrash(eligibleIds);
  } catch {
    const confirmationProfile = trashClient.getRequestProfile();
    const shadowVerification = await completeHistoryShadow(shadow, eligibleIds, new Set());
    const uncertain = updateGmailCleanupJob(running, {
      status: "partial",
      diagnosticResult: "VERIFICATION_PARTIAL",
      attemptedCount: eligibleIds.length,
      verifiedCount: 0,
      failedCount: 0,
      uncertainCount: eligibleIds.length,
      verifiedTrashCount: 0,
      reportMarkedStale: true,
      confirmationRequestProfile: confirmationProfile,
      requestProfile: mergeRequestProfiles(job.previewRequestProfile, confirmationProfile),
      shadowVerification,
      operationStates: { ...running.operationStates, trashVerification: "partial" },
      completedAt: Date.now(),
      error: "Gmail Trash verification was not fully successful. Rescan before continuing."
    });
    return serializeGmailCleanupJob(uncertain);
  }
  const fullyVerified =
    verification.verifiedCount === verification.attemptedCount &&
    verification.failedCount === 0 &&
    verification.uncertainCount === 0;
  const completelyFailed = verification.failedCount === verification.attemptedCount;
  const diagnosticResult =
    batchApiResult === "failed"
      ? "BATCH_MUTATION_FAILED"
      : fullyVerified
        ? "SUCCESS"
        : completelyFailed
          ? "VERIFICATION_FAILED"
          : "VERIFICATION_PARTIAL";
  const confirmationProfile = trashClient.getRequestProfile();
  const requestProfile = mergeRequestProfiles(job.previewRequestProfile, confirmationProfile);
  const shadowVerification = await completeHistoryShadow(shadow, eligibleIds, new Set(verification.verifiedIds));
  const suggestedDeltas = mergeCleanupSuggestedDeltas(
    job.suggestedDeltas ?? [],
    countVerifiedCandidatesByGroup(eligibleCandidates, verification.verifiedIds),
    "moved"
  );

  running = updateGmailCleanupJob(running, {
    status: fullyVerified ? "completed" : completelyFailed ? "failed" : "partial",
    diagnosticResult,
    batchApiResult,
    attemptedCount: verification.attemptedCount,
    verifiedCount: verification.verifiedCount,
    failedCount: verification.failedCount,
    uncertainCount: verification.uncertainCount,
    verifiedTrashCount: verification.verifiedCount,
    reportMarkedStale: true,
    batchMutationMs,
    verificationMs: verification.durationMs,
    totalCleanupMs:
      job.totalCleanupMs + recheck.finalSafetyRecheckMs + batchMutationMs + verification.durationMs,
    confirmationRequestProfile: confirmationProfile,
    requestProfile,
    shadowVerification,
    suggestedDeltas,
    estimatedThousandMessageSafetyMs: estimateThousandSafetyMs(
      job.previewSafetyCheckMs,
      recheck.finalSafetyRecheckMs,
      job.requestedCount
    ),
    operationStates: {
      ...running.operationStates,
      trashVerification: fullyVerified ? "completed" : completelyFailed ? "failed" : "partial"
    },
    completedAt: Date.now(),
    error: fullyVerified ? undefined : "Gmail Trash verification was not fully successful. Rescan before continuing."
  });
  return serializeGmailCleanupJob(running);
}

type PreparedHistoryShadow = { verifier: GmailShadowVerifier; startHistoryId: string } | undefined;

async function prepareHistoryShadow(accessToken: string, targetIds: readonly string[]): Promise<PreparedHistoryShadow> {
  if (!runtimeConfig.gmailHistoryShadowProofEnabled || process.env.NODE_ENV === "production") return undefined;
  try {
    assertGmailShadowProofInput({
      enabled: runtimeConfig.gmailHistoryShadowProofEnabled,
      nodeEnv: process.env.NODE_ENV,
      targetIds
    });
    const verifier = new GmailShadowVerifier(accessToken);
    return { verifier, startHistoryId: await verifier.captureStartHistoryId() };
  } catch {
    return undefined;
  }
}

async function completeHistoryShadow(
  shadow: PreparedHistoryShadow,
  targetIds: readonly string[],
  primaryVerifiedIds: ReadonlySet<string>
) {
  if (!shadow) return undefined;
  try {
    return toShadowSummary(
      primaryVerifiedIds.size,
      await shadow.verifier.verifyTrashShadow({
        targetIds,
        startHistoryId: shadow.startHistoryId,
        primaryVerifiedIds
      })
    );
  } catch {
    return {
      status: "unavailable" as const,
      primaryVerified: primaryVerifiedIds.size,
      historyVerified: 0,
      trashListVerified: 0,
      getFallbackRequired: 0,
      shadowUnresolved: targetIds.length,
      mismatchWithPrimary: primaryVerifiedIds.size,
      historyPages: 0,
      trashListPages: 0,
      getFallbackRequests: 0
    };
  }
}

function toShadowSummary(primaryVerified: number, result: GmailShadowVerificationResult) {
  return {
    status: "complete" as const,
    primaryVerified,
    historyVerified: result.verifiedByHistory,
    trashListVerified: result.verifiedByTrashList,
    getFallbackRequired: result.getFallbackRequired,
    shadowUnresolved: result.unresolvedCount,
    mismatchWithPrimary: result.mismatchWithPrimaryCount,
    historyPages: result.metrics.historyPages,
    trashListPages: result.metrics.trashListPages,
    getFallbackRequests: result.metrics.getFallbackRequests
  };
}

export async function undoGmailCleanup(input: { jobId: string }) {
  const session = await requireSession();
  const job = getGmailCleanupJob(session.userId, input.jobId);
  if (!job) {
    throw new GmailCleanupError("Cleanup result expired. Gmail Trash still lets you restore messages manually.", 410);
  }
  if (job.status === "undone" || job.status === "undo_partial" || job.status === "undo_failed") {
    incrementGmailCleanupDuplicateSubmission(job.id, "undo");
    return serializeGmailCleanupJob(getGmailCleanupJob(session.userId, job.id) ?? job);
  }
  if (job.status === "undoing") {
    const active = runOrJoinGmailCleanupOperation(
      `undo:${job.id}`,
      async () => serializeGmailCleanupJob(job),
      () => incrementGmailCleanupDuplicateSubmission(job.id, "undo")
    );
    return active.promise;
  }
  if (
    job.status !== "completed" ||
    job.attemptedCount === 0 ||
    job.verifiedCount !== job.attemptedCount ||
    job.failedCount !== 0 ||
    job.uncertainCount !== 0
  ) {
    throw new GmailCleanupError("Only fully verified cleanup jobs can be undone.", 409);
  }
  if (job.bulkUndoProof?.state === "running") {
    throw new GmailCleanupError("The bulk Undo proof is still running.", 409);
  }

  const operation = runOrJoinGmailCleanupOperation(
    `undo:${job.id}`,
    () => performGmailCleanupUndo(job, session.userId),
    () => incrementGmailCleanupDuplicateSubmission(job.id, "undo")
  );
  return operation.promise;
}

async function performGmailCleanupUndo(job: GmailCleanupJob, userId: string) {
  const apiMessageIds = job.apiCandidates.map((candidate) => candidate.apiMessageId);
  let undoing = updateGmailCleanupJob(job, {
    status: "undoing",
    undoAttemptedCount: apiMessageIds.length,
    operationStates: { ...job.operationStates, undo: "in_progress" }
  });
  let context: Awaited<ReturnType<typeof assertGmailCleanupContext>>;
  try {
    context = await assertGmailCleanupContext(job.requestedCount, userId);
  } catch (error) {
    updateGmailCleanupJob(undoing, {
      status: "completed",
      undoAttemptedCount: 0,
      operationStates: { ...undoing.operationStates, undo: "not_started" }
    });
    throw error;
  }
  const trashClient = createTrashClient(context.connection.accessToken);
  const undoStartedAt = performance.now();
  if (job.bulkUndoProof?.state === "failed") {
    return performFailedBulkUndoProofRecovery(job, undoing, trashClient, apiMessageIds, undoStartedAt);
  }
  let verification: Awaited<ReturnType<GmailTrashClient["untrashAndVerifyMessages"]>>;
  try {
    verification = await trashClient.untrashAndVerifyMessages(apiMessageIds);
  } catch {
    const undoRequestProfile = trashClient.getRequestProfile();
    const uncertain = updateGmailCleanupJob(undoing, {
      status: "undo_partial",
      diagnosticResult: "UNDO_PARTIAL",
      undoAttemptedCount: apiMessageIds.length,
      undoVerifiedCount: 0,
      undoFailedCount: 0,
      undoUncertainCount: apiMessageIds.length,
      totalUndoMs: Math.round(performance.now() - undoStartedAt),
      undoRequestProfile,
      requestProfile: mergeRequestProfiles(job.requestProfile, undoRequestProfile),
      operationStates: { ...undoing.operationStates, undo: "partial" },
      completedAt: Date.now(),
      error: "Gmail restore verification was not fully successful. Check Gmail Trash manually."
    });
    return serializeGmailCleanupJob(uncertain);
  }
  const undoRequestProfile = trashClient.getRequestProfile();
  const fullyRestored =
    verification.verifiedCount === verification.attemptedCount &&
    verification.failedCount === 0 &&
    verification.uncertainCount === 0;
  const completelyFailed = verification.failedCount === verification.attemptedCount;
  const suggestedDeltas = mergeCleanupSuggestedDeltas(
    job.suggestedDeltas ?? [],
    countVerifiedCandidatesByGroup(job.apiCandidates, verification.verifiedIds),
    "restored"
  );

  undoing = updateGmailCleanupJob(undoing, {
    status: fullyRestored ? "undone" : completelyFailed ? "undo_failed" : "undo_partial",
    diagnosticResult: fullyRestored ? "UNDO_SUCCESS" : completelyFailed ? "UNDO_FAILED" : "UNDO_PARTIAL",
    undoAttemptedCount: verification.attemptedCount,
    undoVerifiedCount: verification.verifiedCount,
    undoFailedCount: verification.failedCount,
    undoUncertainCount: verification.uncertainCount,
    undoFallbackVerificationCount: verification.fallbackVerificationCount,
    untrashMs: verification.untrashMs,
    undoVerificationMs: verification.fallbackVerificationMs,
    totalUndoMs: Math.round(performance.now() - undoStartedAt),
    undoRequestProfile,
    requestProfile: mergeRequestProfiles(job.requestProfile, undoRequestProfile),
    suggestedDeltas,
    operationStates: {
      ...undoing.operationStates,
      undo: fullyRestored ? "completed" : completelyFailed ? "failed" : "partial"
    },
    completedAt: Date.now(),
    error: fullyRestored ? undefined : "Gmail restore verification was not fully successful. Check Gmail Trash manually."
  });
  return serializeGmailCleanupJob(undoing);
}

async function performFailedBulkUndoProofRecovery(
  job: GmailCleanupJob,
  undoing: GmailCleanupJob,
  trashClient: GmailTrashClient,
  apiMessageIds: string[],
  undoStartedAt: number
) {
  let currentState: Awaited<ReturnType<GmailTrashClient["verifyMessagesInTrash"]>>;
  try {
    currentState = await trashClient.verifyMessagesInTrash(apiMessageIds);
  } catch {
    const undoRequestProfile = trashClient.getRequestProfile();
    return serializeGmailCleanupJob(updateGmailCleanupJob(undoing, {
      status: "undo_partial",
      diagnosticResult: "UNDO_PARTIAL",
      undoAttemptedCount: 0,
      undoVerifiedCount: 0,
      undoFailedCount: 0,
      undoUncertainCount: apiMessageIds.length,
      totalUndoMs: Math.round(performance.now() - undoStartedAt),
      undoRequestProfile,
      requestProfile: mergeRequestProfiles(job.requestProfile, undoRequestProfile),
      operationStates: { ...undoing.operationStates, undo: "partial" },
      completedAt: Date.now(),
      error: "Gmail restore verification was not fully successful. Check Gmail Trash manually."
    }));
  }

  const recoveryPlan = createBulkUndoRecoveryPlan(currentState);
  const recoveryIds = recoveryPlan.recoveryIds;
  let recovery: Awaited<ReturnType<GmailTrashClient["untrashAndVerifyMessages"]>> = {
    attemptedCount: 0,
    verifiedCount: 0,
    failedCount: 0,
    uncertainCount: 0,
    durationMs: 0,
    verifiedIds: [],
    failedIds: [],
    uncertainIds: [],
    untrashMs: 0,
    fallbackVerificationCount: 0,
    fallbackVerificationMs: 0
  };
  try {
    if (recoveryIds.length > 0) recovery = await trashClient.untrashAndVerifyMessages(recoveryIds);
  } catch {
    recovery = {
      ...recovery,
      attemptedCount: recoveryIds.length,
      uncertainCount: recoveryIds.length,
      uncertainIds: [...recoveryIds]
    };
  }

  const fullyRestored =
    recoveryPlan.uncertainCount === 0 &&
    recovery.failedCount === 0 &&
    recovery.uncertainCount === 0 &&
    recoveryPlan.alreadyRestoredIds.length + recovery.verifiedCount === apiMessageIds.length;
  const completelyFailed =
    recovery.attemptedCount > 0 &&
    recovery.failedCount === recovery.attemptedCount &&
    recoveryPlan.alreadyRestoredIds.length === 0;
  const restoredIds = [...recoveryPlan.alreadyRestoredIds, ...recovery.verifiedIds];
  const suggestedDeltas = mergeCleanupSuggestedDeltas(
    job.suggestedDeltas ?? [],
    countVerifiedCandidatesByGroup(job.apiCandidates, restoredIds),
    "restored"
  );
  const undoRequestProfile = trashClient.getRequestProfile();
  return serializeGmailCleanupJob(updateGmailCleanupJob(undoing, {
    status: fullyRestored ? "undone" : completelyFailed ? "undo_failed" : "undo_partial",
    diagnosticResult: fullyRestored ? "UNDO_SUCCESS" : completelyFailed ? "UNDO_FAILED" : "UNDO_PARTIAL",
    undoAttemptedCount: apiMessageIds.length,
    undoVerifiedCount: restoredIds.length,
    undoFailedCount: recovery.failedCount,
    undoUncertainCount: recoveryPlan.uncertainCount + recovery.uncertainCount,
    undoFallbackVerificationCount: recovery.fallbackVerificationCount,
    untrashMs: recovery.untrashMs,
    undoVerificationMs: currentState.durationMs + recovery.fallbackVerificationMs,
    totalUndoMs: Math.round(performance.now() - undoStartedAt),
    undoRequestProfile,
    requestProfile: mergeRequestProfiles(job.requestProfile, undoRequestProfile),
    suggestedDeltas,
    operationStates: {
      ...undoing.operationStates,
      undo: fullyRestored ? "completed" : completelyFailed ? "failed" : "partial"
    },
    completedAt: Date.now(),
    error: fullyRestored ? undefined : "Gmail restore verification was not fully successful. Check Gmail Trash manually."
  }));
}

export function parseCleanupCount(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new GmailCleanupError("Cleanup count must be a positive integer.", 400);
  }
  if (getGmailCleanupRequestMode({
    requestedCount: parsed,
    legacyMaximum: runtimeConfig.gmailCleanupMaxMessages,
    scalableEnabled: false
  }) !== "legacy") {
    throw new GmailCleanupError(
      `Cleanup count exceeds the development limit of ${Math.min(runtimeConfig.gmailCleanupMaxMessages, gmailCleanupHardMaximum)}.`,
      400
    );
  }
  return parsed;
}

export async function getGmailCleanupStatus(jobId: string) {
  const session = await requireSession();
  const job = getGmailCleanupJob(session.userId, jobId);
  if (!job) throw new GmailCleanupError("Cleanup operation expired.", 410);
  return serializeGmailCleanupJob(job);
}

export function parseCleanupGroupIndices(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GmailCleanupError("Select at least one cleanup group from the active Inbox Report.", 400);
  }
  const parsed = value.map(Number);
  if (parsed.some((index) => !Number.isInteger(index) || index < 0) || new Set(parsed).size !== parsed.length) {
    throw new GmailCleanupError("Cleanup group selection is invalid.", 400);
  }
  return parsed;
}

export function availableCleanupCounts() {
  const options = [5, 10, 25, 50, 100].filter((count) => count <= runtimeConfig.gmailCleanupMaxMessages);
  return options.length ? options : [runtimeConfig.gmailCleanupMaxMessages];
}

export function publicCleanupGroupsFromReport(senders: Parameters<typeof buildCleanupSenderGroups>[0]) {
  return buildCleanupSenderGroups(senders);
}

async function completeNonMutatingBenchmark(job: GmailCleanupJob, reportSenders: SenderAggregate[], accessToken: string) {
  const confirmationClient = createTrashClient(accessToken);
  const recheck = await runConfirmationRecheck(job, reportSenders, confirmationClient);
  const confirmationProfile = confirmationClient.getRequestProfile();
  const eligibleCandidates = job.apiCandidates.filter((candidate) => recheck.eligibleIds.includes(candidate.apiMessageId));
  const complete = eligibleCandidates.length === job.requestedCount;
  return updateGmailCleanupJob(job, {
    status: complete ? "benchmark_complete" : "insufficient",
    diagnosticResult: complete ? "BENCHMARK_COMPLETE" : "INSUFFICIENT_SAFE_CANDIDATES",
    resolvedCount: eligibleCandidates.length,
    excludedMessageCount: job.excludedMessageCount + recheck.excludedMessageCount,
    exclusionCounts: mergeExclusionCounts(job.exclusionCounts, recheck.exclusionCounts),
    finalSafetyRecheckMs: recheck.finalSafetyRecheckMs,
    totalCleanupMs: job.totalCleanupMs + recheck.finalSafetyRecheckMs,
    confirmationRequestProfile: confirmationProfile,
    requestProfile: mergeRequestProfiles(job.previewRequestProfile, confirmationProfile),
    estimatedThousandMessageSafetyMs: estimateThousandSafetyMs(
      job.previewSafetyCheckMs,
      recheck.finalSafetyRecheckMs,
      job.requestedCount
    ),
    apiCandidates: eligibleCandidates,
    completedAt: Date.now(),
    error: complete ? undefined : "The benchmark found fewer safe messages than requested. Nothing was moved."
  });
}

async function runConfirmationRecheck(job: GmailCleanupJob, reportSenders: SenderAggregate[], client: GmailTrashClient) {
  return client.recheckCleanupCandidates(
    job.groupIndices.map((groupIndex) => ({
      senderAddress: reportSenders[groupIndex].senderKey,
      candidates: job.apiCandidates
        .filter((candidate) => candidate.groupIndex === groupIndex)
        .map(({ apiMessageId, requiresMutableStrongEvidenceRecheck }) => ({
          apiMessageId,
          requiresMutableStrongEvidenceRecheck
        }))
    }))
  );
}

function selectedGroupsRemainEligible(job: GmailCleanupJob, reportSenders: SenderAggregate[]) {
  const groups = buildCleanupSenderGroups(reportSenders);
  return (
    job.groupIndices.every((index) => groups[index]?.eligible) &&
    job.groupIndices.reduce((total, index) => total + groups[index].cleanupCandidateCount, 0) >= job.requestedCount
  );
}

function baseJobFields(input: {
  selectedGroups: ReturnType<typeof buildCleanupSenderGroups>;
  eligibleSenderGroupCount: number;
  requestedCount: number;
  selectedReadyCount: number;
  contributions: number[];
  senderGroupResolution: GmailCleanupJob["senderGroupResolution"];
  benchmarkOnly: boolean;
}): Pick<
  GmailCleanupJob,
  | "groupDisplayName"
  | "groupSecondaryLabel"
  | "criteria"
  | "requestedCount"
  | "reportReadyCount"
  | "eligibleSenderGroupCount"
  | "selectedSenderGroupCount"
  | "eligibleSelectedSenderGroupCount"
  | "selectedReadyCount"
  | "selectedReviewExcludedCount"
  | "selectedProtectedExcludedCount"
  | "contributingSenderGroupCount"
  | "largestContribution"
  | "smallestContribution"
  | "senderGroupResolution"
  | "mutationMethod"
  | "mutationStarted"
  | "benchmarkOnly"
  | "batchApiResult"
  | "attemptedCount"
  | "verifiedCount"
  | "failedCount"
  | "uncertainCount"
  | "verifiedTrashCount"
  | "reportMarkedStale"
  | "batchMutationMs"
  | "verificationMs"
  | "undoAttemptedCount"
  | "undoVerifiedCount"
  | "undoFailedCount"
  | "undoUncertainCount"
  | "undoFallbackVerificationCount"
  | "untrashMs"
  | "undoVerificationMs"
  | "totalUndoMs"
  | "suggestedDeltas"
  | "bulkUndoProofDuplicateSubmissions"
> {
  return {
    groupDisplayName: input.selectedGroups.length === 1 ? input.selectedGroups[0].displayName : `${input.selectedGroups.length} senders`,
    groupSecondaryLabel: input.selectedGroups.length === 1 ? input.selectedGroups[0].secondaryLabel : "Combined selection",
    criteria: `High-confidence sender groups, ${gmailCleanupAgeThresholdLabel}, current protections reapplied, development limited`,
    requestedCount: input.requestedCount,
    reportReadyCount: input.selectedReadyCount,
    eligibleSenderGroupCount: input.eligibleSenderGroupCount,
    selectedSenderGroupCount: input.selectedGroups.length,
    eligibleSelectedSenderGroupCount: input.selectedGroups.filter((group) => group.eligible).length,
    selectedReadyCount: input.selectedReadyCount,
    selectedReviewExcludedCount: input.selectedGroups.reduce((total, group) => total + group.reviewMessages, 0),
    selectedProtectedExcludedCount: input.selectedGroups.reduce((total, group) => total + group.protectedMessages, 0),
    contributingSenderGroupCount: input.contributions.length,
    largestContribution: input.contributions.length ? Math.max(...input.contributions) : 0,
    smallestContribution: input.contributions.length ? Math.min(...input.contributions) : 0,
    senderGroupResolution: input.senderGroupResolution,
    mutationMethod: "batchModify",
    mutationStarted: false,
    benchmarkOnly: input.benchmarkOnly,
    batchApiResult: "not_started",
    attemptedCount: 0,
    verifiedCount: 0,
    failedCount: 0,
    uncertainCount: 0,
    verifiedTrashCount: 0,
    reportMarkedStale: false,
    batchMutationMs: 0,
    verificationMs: 0,
    undoAttemptedCount: 0,
    undoVerifiedCount: 0,
    undoFailedCount: 0,
    undoUncertainCount: 0,
    undoFallbackVerificationCount: 0,
    untrashMs: 0,
    undoVerificationMs: 0,
    totalUndoMs: 0,
    suggestedDeltas: [],
    bulkUndoProofDuplicateSubmissions: 0
  };
}

function createTrashClient(accessToken: string) {
  return new GmailTrashClient(accessToken, {
    requestConcurrency: runtimeConfig.gmailCleanupRecheckConcurrency,
    verificationConcurrency: runtimeConfig.gmailCleanupRecheckConcurrency
  });
}

function emptyRequestProfile(): GmailRequestProfile {
  return {
    requestCount: 0,
    retryCount: 0,
    peakConcurrency: 0,
    durationP50Ms: 0,
    durationP95Ms: 0,
    estimatedQuotaUnits: 0,
    requests: createGmailRequestCounts()
  };
}

function mergeRequestProfiles(first: GmailRequestProfile, second: GmailRequestProfile): GmailRequestProfile {
  const requests = createGmailRequestCounts();
  for (const kind of Object.keys(requests) as Array<keyof typeof requests>) {
    requests[kind] = first.requests[kind] + second.requests[kind];
  }
  return {
    requestCount: first.requestCount + second.requestCount,
    retryCount: first.retryCount + second.retryCount,
    peakConcurrency: Math.max(first.peakConcurrency, second.peakConcurrency),
    durationP50Ms: Math.max(first.durationP50Ms, second.durationP50Ms),
    durationP95Ms: Math.max(first.durationP95Ms, second.durationP95Ms),
    estimatedQuotaUnits: first.estimatedQuotaUnits + second.estimatedQuotaUnits,
    requests
  };
}

function mergeExclusionCounts(first: GmailCleanupExclusionCounts, second: GmailCleanupExclusionCounts) {
  const merged = { ...first };
  for (const reason of gmailCleanupExclusionReasons) merged[reason] += second[reason];
  return merged;
}

function countMutableCandidates(candidates: GmailCleanupStoredCandidate[]) {
  return candidates.filter((candidate) => candidate.requiresMutableStrongEvidenceRecheck).length;
}

export function classifySenderGroupResolutionError(error: unknown) {
  if (!(error instanceof GmailCandidateResolutionStageError)) {
    return new GmailSenderGroupResolutionError("OTHER_SAFE_ENUM", true);
  }
  const reason =
    error.stage === "query"
      ? "QUERY_BUILD_FAILED"
      : error.stage === "list"
        ? "PROVIDER_REQUEST_FAILED"
        : "METADATA_RECHECK_FAILED";
  const providerFailure = error.stage === "query" ? undefined : toProviderFailure(error.stage, error.cause);
  return new GmailSenderGroupResolutionError(
    reason,
    error.stage === "query"
      ? false
      : isGlobalGmailProviderFailure(
          error.stage,
          providerFailure?.reason ?? "GMAIL_UNKNOWN_PROVIDER_ERROR"
        ),
    error.candidateResolutionMs,
    error.previewSafetyCheckMs,
    providerFailure
  );
}

function toProviderFailure(
  stage: "list" | "metadata",
  error: unknown
): GmailSenderGroupProviderFailure {
  return {
    stage: stage === "list" ? "messages.list" : "metadata recheck",
    reason: error instanceof GmailApiRequestError ? error.reason : "GMAIL_UNKNOWN_PROVIDER_ERROR",
    status: error instanceof GmailApiRequestError ? error.status : undefined,
    retryable: error instanceof GmailApiRequestError ? error.retryable : false,
    retriesAttempted: error instanceof GmailApiRequestError ? error.retriesAttempted : 0
  };
}

function isGlobalGmailProviderFailure(
  stage: "list" | "metadata",
  reason: GmailSenderGroupProviderFailure["reason"]
) {
  if (stage === "list") {
    return reason !== "GMAIL_INVALID_QUERY" && reason !== "GMAIL_RESPONSE_INVALID";
  }
  return (
    reason !== "GMAIL_INVALID_QUERY" &&
    reason !== "GMAIL_NOT_FOUND" &&
    reason !== "GMAIL_RESPONSE_INVALID"
  );
}

function toSenderGroupResolutionDiagnostics(
  resolution: GmailSenderGroupResolutionResult
): GmailCleanupJob["senderGroupResolution"] {
  return {
    selectedCount: resolution.selectedCount,
    attemptedCount: resolution.attemptedCount,
    successfulCount: resolution.successfulCount,
    failedCount: resolution.failedCount,
    zeroSafeCandidateCount: resolution.zeroSafeCandidateCount,
    contributingCount: resolution.contributingCount,
    globalFailure: resolution.globalFailure,
    failureReasonCounts: { ...resolution.failureReasonCounts },
    providerFailureReasonCounts: { ...resolution.providerFailureReasonCounts },
    localFailureCount: resolution.localFailureCount,
    globalProviderFailureCount: resolution.globalProviderFailureCount,
    globalApplicationFailureCount: resolution.globalApplicationFailureCount,
    terminalGlobalApplicationFailureCount: resolution.terminalGlobalApplicationFailureCount,
    classifiedFailureCount: resolution.classifiedFailureCount,
    failureAccountingInvariant: resolution.failureAccountingInvariant,
    failedGroups:
      process.env.NODE_ENV === "production"
        ? []
        : resolution.failures.map(({ group, reason, globalFailure, providerFailure }) => ({
            label: safeDiagnosticGroupLabel(group.displayName),
            domain: safeDiagnosticDomain(group.secondaryLabel),
            reason,
            stage: providerFailure?.stage ?? senderGroupFailureStage(reason),
            providerReason: providerFailure?.reason,
            httpStatus: providerFailure?.status,
            retryable: providerFailure?.retryable ?? false,
            retriesAttempted: providerFailure?.retriesAttempted ?? 0,
            globalFailure
          }))
  };
}

function emptySenderGroupResolutionDiagnostics(selectedCount: number): GmailCleanupJob["senderGroupResolution"] {
  return {
    selectedCount,
    attemptedCount: 0,
    successfulCount: 0,
    failedCount: 0,
    zeroSafeCandidateCount: 0,
    contributingCount: 0,
    globalFailure: true,
    failureReasonCounts: createGmailSenderGroupFailureCounts(),
    providerFailureReasonCounts: createGmailProviderErrorCounts(),
    localFailureCount: 0,
    globalProviderFailureCount: 0,
    globalApplicationFailureCount: 1,
    terminalGlobalApplicationFailureCount: 1,
    classifiedFailureCount: 1,
    failureAccountingInvariant: true,
    failedGroups: []
  };
}

function senderGroupFailureStage(reason: keyof ReturnType<typeof createGmailSenderGroupFailureCounts>) {
  if (reason === "QUERY_BUILD_FAILED" || reason === "INVALID_SENDER_IDENTITY") return "query build";
  if (reason === "METADATA_RECHECK_FAILED") return "metadata recheck";
  if (reason === "PROVIDER_REQUEST_FAILED") return "messages.list";
  return "group validation";
}

function safeDiagnosticGroupLabel(displayName: string) {
  const normalized = displayName.replace(/[\r\n\t]/g, " ").trim();
  return !normalized || normalized.includes("@") ? "Sender group" : normalized.slice(0, 120);
}

function safeDiagnosticDomain(value: string) {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return /^[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?$/u.test(normalized)
    ? normalized.slice(0, 253)
    : undefined;
}

function resolutionFailureMessage(failedGroupCount: number) {
  const skipped = failedGroupCount
    ? `${failedGroupCount.toLocaleString("en-US")} sender ${failedGroupCount === 1 ? "group was" : "groups were"} left alone because ${failedGroupCount === 1 ? "it" : "they"} couldn't be checked safely. `
    : "";
  return `${skipped}Fewer messages passed the full safety check than requested. Nothing was moved.`;
}

function estimateThousandQuota(senderGroupCount: number, mutableCandidateCount: number) {
  const mutableRatio = mutableCandidateCount / Math.max(1, gmailCleanupHardMaximum);
  return estimateGmailCleanupQuota({
    messageCount: 1000,
    senderGroupCount,
    confirmationLabelChecks: Math.ceil(1000 * mutableRatio)
  }).beforeUndo;
}

function estimateThousandSafetyMs(previewMs: number, confirmationMs: number, messageCount: number) {
  if (messageCount <= 0) return 0;
  return Math.round(((previewMs + confirmationMs) / messageCount) * 1000);
}

async function assertGmailCleanupContext(requestedCount: number, userIdOverride?: string) {
  const session = userIdOverride ? { userId: userIdOverride } : await requireSession();
  if (process.env.NODE_ENV === "production") {
    throw new GmailCleanupError("Gmail cleanup is disabled in production.", 403);
  }
  if (runtimeConfig.fixtureMode) throw new GmailCleanupError("Fixture mode cannot perform real Gmail mutations.", 403);
  if (!runtimeConfig.gmailCleanupEnabled) {
    throw new GmailCleanupError(
      "Gmail cleanup is disabled. Set GMAIL_CLEANUP_ENABLED=\"true\" for the local Trash-only test.",
      403
    );
  }
  parseCleanupCount(requestedCount);

  const liveScan = getLiveScan(session.userId);
  if (!liveScan?.report || liveScan.progress.status !== "completed" || liveScan.progress.provider !== "gmail") {
    throw new GmailCleanupError("A completed live Gmail report is required before cleanup.", 409);
  }
  const participatedConversationIds = liveScan.participatedConversationIds;
  if (!participatedConversationIds) {
    throw new GmailCleanupError("Conversation protection has expired. Run a fresh Gmail scan before cleanup.", 409);
  }

  const connection = await getActiveGmailConnection(session.userId);
  if (!connection) throw new GmailCleanupError("An authenticated Gmail connection is required before cleanup.", 401);
  return { userId: session.userId, liveScan: { ...liveScan, participatedConversationIds }, connection };
}

async function requireSession() {
  const session = await getSession();
  if (!session?.userId) throw new GmailCleanupError("Sign in with Gmail before starting cleanup.", 401);
  return session;
}
