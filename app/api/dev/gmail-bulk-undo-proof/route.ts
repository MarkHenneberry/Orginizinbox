import { NextResponse } from "next/server";
import { runtimeConfig } from "@/lib/config";
import { mergeCleanupSuggestedDeltas } from "@/lib/domain/cleanup-session-adjustments";
import {
  createGmailBulkUndoProofSummary,
  projectGmailBulkUndoQuota,
  type GmailBulkUndoProofSummary
} from "@/lib/domain/gmail-bulk-undo-proof-summary";
import {
  assertGmailBulkUndoProofInput,
  executeGmailBulkUndoProof,
  parseGmailBulkUndoProofRequest
} from "@/lib/providers/gmail/bulk-undo-proof";
import { gmailScaleQuotaUnits } from "@/lib/providers/gmail/scale-architecture";
import {
  GmailUndoHistoryShadowVerifier,
  type GmailUndoHistoryShadowMetrics,
  type GmailUndoHistoryShadowResult
} from "@/lib/providers/gmail/undo-history-shadow-verifier";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { countVerifiedCandidatesByGroup } from "@/lib/server/gmail-cleanup-adjustments";
import {
  getGmailCleanupJob,
  incrementGmailBulkUndoProofDuplicateSubmission,
  runOrJoinGmailCleanupOperation,
  serializeGmailCleanupJob,
  updateGmailCleanupJob,
  type GmailCleanupJob
} from "@/lib/server/gmail-cleanup-store";
import { getSession } from "@/lib/server/session";

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const body = parseGmailBulkUndoProofRequest(await request.json());
    if (!body.jobId) return NextResponse.json({ error: "Cleanup result id is required." }, { status: 400 });
    const job = getGmailCleanupJob(session.userId, body.jobId);
    if (!isEligibleProofJob(job)) {
      return NextResponse.json({ error: "A fully verified 25-message Trash result is required." }, { status: 409 });
    }
    if (job.bulkUndoProof) {
      return NextResponse.json({ error: "The bulk Undo proof has already been run for this cleanup." }, { status: 409 });
    }
    const targetIds = assertGmailBulkUndoProofInput({
      enabled: runtimeConfig.gmailBulkUndoProofEnabled,
      historyShadowEnabled: runtimeConfig.gmailBulkUndoHistoryShadowEnabled,
      approved: body.approved,
      nodeEnv: process.env.NODE_ENV,
      targetIds: job.apiCandidates.map((candidate) => candidate.apiMessageId)
    });
    const connection = await getActiveGmailConnection(session.userId, session.providerConnectionId);
    if (!connection) return NextResponse.json({ error: "Gmail connection required." }, { status: 409 });

    const operation = runOrJoinGmailCleanupOperation(
      `bulk-undo-proof:${job.id}`,
      () => performBulkUndoProof(job, connection.accessToken, targetIds),
      () => incrementGmailBulkUndoProofDuplicateSubmission(job.id)
    );
    return NextResponse.json({ job: serializeGmailCleanupJob(await operation.promise) });
  } catch {
    return NextResponse.json({ error: "The bulk Undo proof could not be started." }, { status: 400 });
  }
}

function isEligibleProofJob(job: GmailCleanupJob | undefined): job is GmailCleanupJob {
  return Boolean(
    job &&
    job.status === "completed" &&
    job.attemptedCount === 25 &&
    job.apiCandidates.length === 25 &&
    job.verifiedCount === 25 &&
    job.failedCount === 0 &&
    job.uncertainCount === 0
  );
}

async function performBulkUndoProof(job: GmailCleanupJob, accessToken: string, targetIds: readonly string[]) {
  const proofStartedAt = performance.now();
  updateGmailCleanupJob(job, { bulkUndoProof: runningProofSummary() });
  const shadowVerifier = new GmailUndoHistoryShadowVerifier(accessToken);
  let startHistoryId: string;
  try {
    startHistoryId = await shadowVerifier.captureStartHistoryId();
  } catch {
    const metrics = shadowVerifier.getMetrics();
    return updateGmailCleanupJob(job, {
      bulkUndoProof: checkpointFailureSummary(
        job.verifiedCount,
        metrics.getProfileRequests,
        metrics.retryRequests,
        Math.round(performance.now() - proofStartedAt)
      )
    });
  }

  const result = await executeGmailBulkUndoProof({ accessToken, targetIds });
  const shadow = result.apiResult === "success"
    ? await shadowVerifier.verifyTrashRemovalShadow({
      targetIds,
      startHistoryId,
      primaryRestoredIds: new Set(result.verifiedRestoredIds)
    })
    : emptyShadowResult(targetIds.length, shadowVerifier.getMetrics());
  const proof = createGmailBulkUndoProofSummary({
    checkpointStatus: "success",
    verifiedCleanupMessages: job.verifiedCount,
    batchModifyRequests: result.batchModifyRequests,
    attemptedCount: result.attemptedCount,
    apiResult: result.apiResult,
    primaryVerificationRequests: result.verificationRequests,
    verifiedRestoredCount: result.verifiedRestoredCount,
    stillInTrashCount: result.failedCount,
    uncertainCount: result.uncertainCount,
    profileCheckpoints: 1,
    profileRequests: shadow.metrics.getProfileRequests,
    historyListRequests: shadow.metrics.historyListRequests,
    historyPages: shadow.metrics.historyPages,
    historyPollingAttempts: shadow.metrics.historyPollAttempts,
    historyRetries: shadow.metrics.retryRequests,
    historyVerifiedRestoredCount: shadow.verifiedByHistory,
    historyFallbackVerifiedCount: shadow.verifiedByGetFallback,
    historyFallbackRequests: shadow.metrics.getFallbackRequests,
    shadowUnresolvedCount: shadow.unresolvedCount,
    mismatchWithPrimaryCount: shadow.mismatchWithPrimaryCount,
    historyUnavailable: shadow.historyUnavailable,
    batchModifyUnitCost: gmailScaleQuotaUnits.batchModify,
    primaryVerificationUnitCost: gmailScaleQuotaUnits.messagesGet,
    profileUnitCost: gmailScaleQuotaUnits.getProfile,
    historyListUnitCost: gmailScaleQuotaUnits.historyList,
    shadowFallbackUnitCost: gmailScaleQuotaUnits.messagesGet,
    mutationMs: result.mutationMs,
    primaryVerificationMs: result.verificationMs,
    historyVerificationMs: shadow.historyWallTimeMs,
    totalMs: Math.round(performance.now() - proofStartedAt)
  });
  const suggestedDeltas = mergeCleanupSuggestedDeltas(
    job.suggestedDeltas ?? [],
    countVerifiedCandidatesByGroup(job.apiCandidates, result.verifiedRestoredIds),
    "restored"
  );
  if (!proof.primaryPass) return updateGmailCleanupJob(job, { bulkUndoProof: proof, suggestedDeltas });
  return updateGmailCleanupJob(job, {
    status: "undone",
    diagnosticResult: "UNDO_SUCCESS",
    undoAttemptedCount: result.attemptedCount,
    undoVerifiedCount: result.verifiedRestoredCount,
    undoFailedCount: 0,
    undoUncertainCount: 0,
    suggestedDeltas,
    bulkUndoProof: proof,
    operationStates: { ...job.operationStates, undo: "completed" },
    completedAt: Date.now()
  });
}

function checkpointFailureSummary(
  verifiedCleanupMessages: number,
  profileRequests: number,
  historyRetries: number,
  totalMs: number
) {
  return createGmailBulkUndoProofSummary({
    checkpointStatus: "failure",
    verifiedCleanupMessages,
    attemptedCount: 25,
    verifiedRestoredCount: 0,
    stillInTrashCount: 0,
    uncertainCount: 25,
    batchModifyRequests: 0,
    primaryVerificationRequests: 0,
    apiResult: "failure",
    profileCheckpoints: 0,
    profileRequests,
    historyListRequests: 0,
    historyPages: 0,
    historyPollingAttempts: 0,
    historyRetries,
    historyVerifiedRestoredCount: 0,
    historyFallbackVerifiedCount: 0,
    historyFallbackRequests: 0,
    shadowUnresolvedCount: 25,
    mismatchWithPrimaryCount: 0,
    historyUnavailable: true,
    batchModifyUnitCost: gmailScaleQuotaUnits.batchModify,
    primaryVerificationUnitCost: gmailScaleQuotaUnits.messagesGet,
    profileUnitCost: gmailScaleQuotaUnits.getProfile,
    historyListUnitCost: gmailScaleQuotaUnits.historyList,
    shadowFallbackUnitCost: gmailScaleQuotaUnits.messagesGet,
    mutationMs: 0,
    primaryVerificationMs: 0,
    historyVerificationMs: 0,
    totalMs
  });
}

function emptyShadowResult(
  targetCount: number,
  metrics: GmailUndoHistoryShadowMetrics
): GmailUndoHistoryShadowResult {
  return {
    targetCount,
    verifiedByHistory: 0,
    verifiedByGetFallback: 0,
    unresolvedCount: targetCount,
    mismatchWithPrimaryCount: 0,
    historyUnavailable: false,
    historyWallTimeMs: 0,
    metrics: {
      ...metrics,
      historyListRequests: 0,
      historyPages: 0,
      historyPollAttempts: 0,
      getFallbackRequests: 0
    }
  };
}

function runningProofSummary(): GmailBulkUndoProofSummary {
  return {
    state: "running",
    verifiedCleanupMessages: 25,
    proofTarget: 25,
    mutationMethod: "batchModify remove TRASH",
    batchModifyRequests: 0,
    attemptedCount: 25,
    apiResult: "pending",
    primaryVerificationRequests: 0,
    verifiedRestoredCount: 0,
    stillInTrashCount: 0,
    uncertainCount: 25,
    profileCheckpoints: 0,
    profileRequests: 0,
    historyListRequests: 0,
    historyPages: 0,
    historyPollingAttempts: 0,
    historyRetries: 0,
    historyVerifiedRestoredCount: 0,
    historyFallbackVerifiedCount: 0,
    historyFallbackRequests: 0,
    shadowUnresolvedCount: 25,
    mismatchWithPrimaryCount: 0,
    historyUnavailable: false,
    primaryPass: false,
    shadowComparisonPass: false,
    batchModifyUnits: 0,
    primaryVerificationUnits: 0,
    historyUnits: 0,
    shadowFallbackUnits: 0,
    totalProofUnits: 0,
    mutationMs: 0,
    primaryVerificationMs: 0,
    historyVerificationMs: 0,
    totalMs: 0,
    individualUntrashRequired: false,
    fallbackMessages: 0,
    projectedUndoQuota: projectGmailBulkUndoQuota(0),
    result: "PENDING"
  };
}
