export type GmailBulkUndoProofResultCode =
  | "PENDING"
  | "BULK_UNDO_25_PROOF_SUCCESS"
  | "BULK_UNDO_25_CHECKPOINT_FAILED"
  | "BULK_UNDO_25_MUTATION_FAILED"
  | "BULK_UNDO_25_PRIMARY_FAILED"
  | "BULK_UNDO_25_HISTORY_SHADOW_FAILED";

export type GmailProjectedUndoQuota = {
  targetCount: number;
  batchModifyRequests: number;
  mutationUnits: number;
  profileUnits: number;
  historyUnitsReference: number;
  projectedCoreUnits: number;
  worstCaseGetFallbackUnits: number;
};

export type GmailBulkUndoProofSummary = {
  state: "running" | "success" | "failed";
  verifiedCleanupMessages: number;
  proofTarget: number;
  mutationMethod: "batchModify remove TRASH";
  batchModifyRequests: number;
  attemptedCount: number;
  apiResult: "pending" | "success" | "failure";
  primaryVerificationRequests: number;
  verifiedRestoredCount: number;
  stillInTrashCount: number;
  uncertainCount: number;
  profileCheckpoints: number;
  profileRequests: number;
  historyListRequests: number;
  historyPages: number;
  historyPollingAttempts: number;
  historyRetries: number;
  historyVerifiedRestoredCount: number;
  historyFallbackVerifiedCount: number;
  historyFallbackRequests: number;
  shadowUnresolvedCount: number;
  mismatchWithPrimaryCount: number;
  historyUnavailable: boolean;
  primaryPass: boolean;
  shadowComparisonPass: boolean;
  batchModifyUnits: number;
  primaryVerificationUnits: number;
  historyUnits: number;
  shadowFallbackUnits: number;
  totalProofUnits: number;
  mutationMs: number;
  primaryVerificationMs: number;
  historyVerificationMs: number;
  totalMs: number;
  individualUntrashRequired: boolean;
  fallbackMessages: number;
  projectedUndoQuota: GmailProjectedUndoQuota[];
  result: GmailBulkUndoProofResultCode;
};

export function createGmailBulkUndoProofSummary(input: {
  checkpointStatus: "success" | "failure";
  verifiedCleanupMessages: number;
  attemptedCount: number;
  verifiedRestoredCount: number;
  stillInTrashCount: number;
  uncertainCount: number;
  batchModifyRequests: number;
  primaryVerificationRequests: number;
  apiResult: "success" | "failure";
  profileCheckpoints: number;
  profileRequests: number;
  historyListRequests: number;
  historyPages: number;
  historyPollingAttempts: number;
  historyRetries: number;
  historyVerifiedRestoredCount: number;
  historyFallbackVerifiedCount: number;
  historyFallbackRequests: number;
  shadowUnresolvedCount: number;
  mismatchWithPrimaryCount: number;
  historyUnavailable: boolean;
  batchModifyUnitCost: number;
  primaryVerificationUnitCost: number;
  profileUnitCost: number;
  historyListUnitCost: number;
  shadowFallbackUnitCost: number;
  mutationMs: number;
  primaryVerificationMs: number;
  historyVerificationMs: number;
  totalMs: number;
}): GmailBulkUndoProofSummary {
  const accountingPass = input.attemptedCount ===
    input.verifiedRestoredCount + input.stillInTrashCount + input.uncertainCount;
  const primaryPass =
    input.checkpointStatus === "success" &&
    input.apiResult === "success" &&
    accountingPass &&
    input.attemptedCount === 25 &&
    input.verifiedRestoredCount === 25 &&
    input.stillInTrashCount === 0 &&
    input.uncertainCount === 0;
  const shadowComparisonPass =
    primaryPass &&
    input.historyVerifiedRestoredCount + input.historyFallbackVerifiedCount === 25 &&
    input.shadowUnresolvedCount === 0 &&
    input.mismatchWithPrimaryCount === 0;
  const result = proofResult(input.checkpointStatus, input.apiResult, primaryPass, shadowComparisonPass);
  const batchModifyUnits = input.batchModifyRequests * input.batchModifyUnitCost;
  const primaryVerificationUnits = input.primaryVerificationRequests * input.primaryVerificationUnitCost;
  const historyUnits =
    input.profileRequests * input.profileUnitCost +
    input.historyListRequests * input.historyListUnitCost;
  const shadowFallbackUnits = input.historyFallbackRequests * input.shadowFallbackUnitCost;

  return {
    state: shadowComparisonPass ? "success" : "failed",
    verifiedCleanupMessages: input.verifiedCleanupMessages,
    proofTarget: 25,
    mutationMethod: "batchModify remove TRASH",
    batchModifyRequests: input.batchModifyRequests,
    attemptedCount: input.attemptedCount,
    apiResult: input.apiResult,
    primaryVerificationRequests: input.primaryVerificationRequests,
    verifiedRestoredCount: input.verifiedRestoredCount,
    stillInTrashCount: input.stillInTrashCount,
    uncertainCount: input.uncertainCount,
    profileCheckpoints: input.profileCheckpoints,
    profileRequests: input.profileRequests,
    historyListRequests: input.historyListRequests,
    historyPages: input.historyPages,
    historyPollingAttempts: input.historyPollingAttempts,
    historyRetries: input.historyRetries,
    historyVerifiedRestoredCount: input.historyVerifiedRestoredCount,
    historyFallbackVerifiedCount: input.historyFallbackVerifiedCount,
    historyFallbackRequests: input.historyFallbackRequests,
    shadowUnresolvedCount: input.shadowUnresolvedCount,
    mismatchWithPrimaryCount: input.mismatchWithPrimaryCount,
    historyUnavailable: input.historyUnavailable,
    primaryPass,
    shadowComparisonPass,
    batchModifyUnits,
    primaryVerificationUnits,
    historyUnits,
    shadowFallbackUnits,
    totalProofUnits: batchModifyUnits + primaryVerificationUnits + historyUnits + shadowFallbackUnits,
    mutationMs: input.mutationMs,
    primaryVerificationMs: input.primaryVerificationMs,
    historyVerificationMs: input.historyVerificationMs,
    totalMs: input.totalMs,
    individualUntrashRequired: !primaryPass,
    fallbackMessages: input.attemptedCount - input.verifiedRestoredCount,
    projectedUndoQuota: projectGmailBulkUndoQuota(input.historyPages, {
      batchModify: input.batchModifyUnitCost,
      getProfile: input.profileUnitCost,
      historyList: input.historyListUnitCost,
      messagesGet: input.shadowFallbackUnitCost
    }),
    result
  };
}

export function projectGmailBulkUndoQuota(
  measuredHistoryPagesPerBatch: number,
  unitCosts = { batchModify: 50, getProfile: 1, historyList: 2, messagesGet: 20 }
): GmailProjectedUndoQuota[] {
  return [100, 250, 500, 1_000, 5_000].map((targetCount) => {
    const batchModifyRequests = Math.ceil(targetCount / 1_000);
    const mutationUnits = batchModifyRequests * unitCosts.batchModify;
    const profileUnits = batchModifyRequests * unitCosts.getProfile;
    const historyUnitsReference = batchModifyRequests * measuredHistoryPagesPerBatch * unitCosts.historyList;
    return {
      targetCount,
      batchModifyRequests,
      mutationUnits,
      profileUnits,
      historyUnitsReference,
      projectedCoreUnits: mutationUnits + profileUnits + historyUnitsReference,
      worstCaseGetFallbackUnits: targetCount * unitCosts.messagesGet
    };
  });
}

export function formatDevelopmentBulkUndoProofSummary(proof: GmailBulkUndoProofSummary) {
  return [
    "ORGANIZINBOX DEV 25-MESSAGE BULK UNDO PROOF",
    "",
    "Input",
    `Verified cleanup messages: ${proof.verifiedCleanupMessages}`,
    `Bulk Undo targets: ${proof.proofTarget}`,
    "",
    "Bulk mutation",
    `Method: ${proof.mutationMethod}`,
    `Requests: ${proof.batchModifyRequests}`,
    `Attempted: ${proof.attemptedCount}`,
    `API result: ${proof.apiResult}`,
    "",
    "Primary verification",
    `Verification requests: ${proof.primaryVerificationRequests}`,
    `Verified restored: ${proof.verifiedRestoredCount}`,
    `Still in Trash: ${proof.stillInTrashCount}`,
    `Uncertain: ${proof.uncertainCount}`,
    "",
    "History shadow",
    `Profile checkpoints: ${proof.profileCheckpoints}`,
    `History list requests: ${proof.historyListRequests}`,
    `History pages: ${proof.historyPages}`,
    `Polling attempts: ${proof.historyPollingAttempts}`,
    `History retries: ${proof.historyRetries}`,
    `History unavailable: ${proof.historyUnavailable ? "yes" : "no"}`,
    `History verified restored: ${proof.historyVerifiedRestoredCount}`,
    `Fallback verified: ${proof.historyFallbackVerifiedCount}`,
    `Shadow unresolved: ${proof.shadowUnresolvedCount}`,
    `Mismatch with primary: ${proof.mismatchWithPrimaryCount}`,
    "",
    "Accounting",
    `Primary: ${proof.primaryPass ? "PASS" : "FAIL"}`,
    `Shadow comparison: ${proof.shadowComparisonPass ? "PASS" : "FAIL"}`,
    "",
    "Quota",
    `Bulk mutation units: ${proof.batchModifyUnits}`,
    `Primary verification units: ${proof.primaryVerificationUnits}`,
    `History units: ${proof.historyUnits}`,
    `Shadow fallback units: ${proof.shadowFallbackUnits}`,
    `Total proof units: ${proof.totalProofUnits}`,
    "",
    "Scalable projected Undo",
    "Measured history pages are used only as a reference per <=1000-target batch.",
    ...proof.projectedUndoQuota.map((projection) =>
      `${projection.targetCount.toLocaleString()}: core ${projection.projectedCoreUnits} units; ` +
      `mutation ${projection.mutationUnits}; history ${projection.historyUnitsReference}; ` +
      `worst-case GET fallback ${projection.worstCaseGetFallbackUnits}`
    ),
    "",
    "Performance",
    `Bulk mutation: ${proof.mutationMs} ms`,
    `Primary verification: ${proof.primaryVerificationMs} ms`,
    `History verification: ${proof.historyVerificationMs} ms`,
    `Total proof: ${proof.totalMs} ms`,
    "",
    "Fallback",
    `Individual untrash required: ${proof.individualUntrashRequired ? "yes" : "no"}`,
    `Fallback messages: ${proof.fallbackMessages}`,
    "",
    "Result",
    proof.result,
    "",
    "Safety",
    "Permanent delete used: no",
    "Message IDs persisted: no",
    "Bodies fetched: no",
    "Subjects fetched: no"
  ].join("\n");
}

function proofResult(
  checkpointStatus: "success" | "failure",
  apiResult: "success" | "failure",
  primaryPass: boolean,
  shadowComparisonPass: boolean
): GmailBulkUndoProofResultCode {
  if (checkpointStatus === "failure") return "BULK_UNDO_25_CHECKPOINT_FAILED";
  if (apiResult === "failure") return "BULK_UNDO_25_MUTATION_FAILED";
  if (!primaryPass) return "BULK_UNDO_25_PRIMARY_FAILED";
  if (!shadowComparisonPass) return "BULK_UNDO_25_HISTORY_SHADOW_FAILED";
  return "BULK_UNDO_25_PROOF_SUCCESS";
}
