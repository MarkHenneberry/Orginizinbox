import {
  assertScaleAccounting,
  GmailQuotaBudget,
  gmailScalePolicy,
  type GmailScaleChunkResult
} from "@/lib/providers/gmail/scale-architecture";
import { gmailScalableCleanupDevCounts } from "@/lib/domain/gmail-cleanup-request-mode";

export { gmailScalableCleanupDevCounts } from "@/lib/domain/gmail-cleanup-request-mode";
export const gmailScalableCleanupDevMaximum = 500;

export function assertGmailScalableDevelopmentGate(input: {
  enabled: boolean;
  nodeEnv: string | undefined;
  requestedCount: number;
}) {
  if (!input.enabled || input.nodeEnv === "production") throw new Error("Scalable Gmail cleanup is disabled.");
  if (!Number.isInteger(input.requestedCount) || !gmailScalableCleanupDevCounts.includes(input.requestedCount as 250 | 500)) {
    throw new Error("Controlled scalable cleanup requires exactly 250 or 500 messages.");
  }
}

export function isGmailScalablePostStateAuditEnabled(input: {
  auditEnabled: boolean;
  scalableCleanupEnabled: boolean;
  nodeEnv: string | undefined;
}) {
  return input.auditEnabled && input.scalableCleanupEnabled && input.nodeEnv !== "production";
}

export const gmailScalableJobStatuses = [
  "created",
  "safety_checking",
  "ready",
  "mutating",
  "verifying",
  "chunk_complete",
  "paused",
  "complete",
  "partial",
  "uncertain",
  "failed",
  "undoing",
  "undo_complete",
  "expired"
] as const;

export type GmailScalableJobStatus = (typeof gmailScalableJobStatuses)[number];

export const gmailScalableChunkStatuses = [
  "pending",
  "safety_checking",
  "ready",
  "mutating",
  "verifying",
  "complete",
  "partial",
  "uncertain",
  "failed",
  "undoing",
  "undo_complete"
] as const;

export type GmailScalableChunkStatus = (typeof gmailScalableChunkStatuses)[number];

export type GmailScalableChunkView = GmailScaleChunkResult & {
  index: number;
  status: GmailScalableChunkStatus;
  targetCount: number;
  preflightCheckedCount: number;
  preflightSafeCount: number;
  preflightExcludedCount: number;
  safeCount: number;
  excludedCount: number;
  historyVerifiedCount: number;
  listVerifiedCount: number;
  getVerifiedCount: number;
  getFallbackRequests: number;
  retryCount: number;
  quotaUnits: number;
  uidValidityValid: boolean;
  idMatchCount: number;
  missingCount: number;
  identityMismatchCount: number;
  starredExcludedCount: number;
  importantExcludedCount: number;
  sentExcludedCount: number;
  draftExcludedCount: number;
  personalExcludedCount: number;
  personalListRequests: number;
  profileRequests: number;
  batchModifyRequests: number;
  historyRequests: number;
  historyPages: number;
  fallbackListRequests: number;
  fallbackListPages: number;
  imapMs: number;
  personalMs: number;
  mutationMs: number;
  verificationMs: number;
  undoMutationRequests: number;
  undoHistoryVerifiedCount: number;
  undoFallbackVerifiedCount: number;
  undoQuotaUnits: number;
  verifiedRestoredCount: number;
  failedRestoreCount: number;
  uncertainRestoreCount: number;
  startedAt?: number;
  completedAt?: number;
};

export type GmailScalableSuggestedDelta = {
  groupIndex: number;
  verifiedMovedCount: number;
  verifiedRestoredCount: number;
};

export type GmailScalablePostStateAuditPhase = {
  state: "complete" | "failed";
  targetCount: number;
  authoritativeHistoryVerifiedCount: number;
  exactTargetMessagesFoundInTrash: number;
  exactTargetMessagesAbsentFromTrash: number;
  distinctGmailThreadCount: number;
  trashListRequests: number;
  trashListPages: number;
  mismatchCount: number;
  error?: string;
};

export type GmailScalablePostStateAudit = {
  cleanup?: GmailScalablePostStateAuditPhase;
  undo?: GmailScalablePostStateAuditPhase;
};

export type GmailScalableRestoreMode = "undo" | "recovery";

export type GmailScalableJobView = {
  id: string;
  status: GmailScalableJobStatus;
  requestedCount: number;
  chunkSize: number;
  chunkCount: number;
  safeCount: number;
  excludedCount: number;
  attemptedCount: number;
  verifiedCount: number;
  failedCount: number;
  uncertainCount: number;
  verifiedRestoredCount: number;
  failedRestoreCount: number;
  uncertainRestoreCount: number;
  verifiedProcessedCount: number;
  progressLabel: string;
  quotaConsumedUnits: number;
  developmentAuditQuotaUnits: number;
  quotaWorkingLimit: number;
  nextEligibleRunAt?: number;
  suggestedDeltas: GmailScalableSuggestedDelta[];
  groupIndices: number[];
  chunks: GmailScalableChunkView[];
  undoAvailable: boolean;
  restoreMode?: GmailScalableRestoreMode;
  jobTerminal?: boolean;
  chunksComplete?: number;
  nextChunk?: number;
  workflowContinuationExpected?: boolean;
  recoveryRestoreAvailable?: boolean;
  recoveryRestoreCount?: number;
  recoveryRestoreReason?: string;
  duplicateStartCount: number;
  duplicateDispatchCount: number;
  duplicateUndoCount: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  postStateAudit?: GmailScalablePostStateAudit;
  terminalDiagnostic?: string;
  terminalSnapshotVersion?: number;
  completedAt?: number;
  error?: string;
};

const validTransitions: Record<GmailScalableJobStatus, ReadonlySet<GmailScalableJobStatus>> = {
  created: new Set(["safety_checking", "failed", "expired"]),
  safety_checking: new Set(["ready", "mutating", "chunk_complete", "complete", "paused", "failed", "expired"]),
  ready: new Set(["safety_checking", "mutating", "failed", "expired"]),
  mutating: new Set(["verifying", "paused", "uncertain", "failed", "expired"]),
  verifying: new Set(["chunk_complete", "paused", "partial", "uncertain", "failed", "expired"]),
  chunk_complete: new Set(["safety_checking", "complete", "partial", "paused", "undoing", "expired"]),
  paused: new Set(["safety_checking", "mutating", "verifying", "undoing", "failed", "expired"]),
  complete: new Set(["undoing", "expired"]),
  partial: new Set(["undoing", "expired"]),
  uncertain: new Set(["verifying", "undoing", "expired"]),
  failed: new Set(["undoing", "expired"]),
  undoing: new Set(["undo_complete", "paused", "uncertain", "failed", "expired"]),
  undo_complete: new Set(["expired"]),
  expired: new Set()
};

export function assertGmailScalableTransition(from: GmailScalableJobStatus, to: GmailScalableJobStatus) {
  if (from === to || validTransitions[from].has(to)) return;
  throw new Error(`Invalid scalable cleanup transition: ${from} -> ${to}.`);
}

export function createGmailScalableChunkViews(
  targetCount: number,
  chunkSize = gmailScalePolicy.mutationChunkSize
): GmailScalableChunkView[] {
  if (!Number.isInteger(targetCount) || targetCount < 1) throw new Error("Scalable cleanup target count must be positive.");
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1_000) {
    throw new Error("Scalable cleanup chunk size must be between 1 and 1000.");
  }
  const chunks: GmailScalableChunkView[] = [];
  for (let offset = 0, index = 0; offset < targetCount; offset += chunkSize, index += 1) {
    chunks.push(emptyChunk(index, Math.min(chunkSize, targetCount - offset)));
  }
  return chunks;
}

export function summarizeGmailScalableChunks(chunks: readonly GmailScalableChunkView[]) {
  const accounting = chunks.reduce(
    (total, chunk) => {
      if (["complete", "partial", "uncertain", "failed", "undo_complete"].includes(chunk.status)) {
        assertScaleAccounting(chunk);
      }
      total.safeCount += chunk.safeCount;
      total.excludedCount += chunk.excludedCount;
      total.attemptedCount += chunk.attemptedCount;
      total.verifiedCount += chunk.verifiedCount;
      total.failedCount += chunk.failedCount;
      total.uncertainCount += chunk.uncertainCount;
      total.verifiedRestoredCount += chunk.verifiedRestoredCount;
      total.failedRestoreCount += chunk.failedRestoreCount;
      total.uncertainRestoreCount += chunk.uncertainRestoreCount;
      total.quotaUnits += chunk.quotaUnits;
      return total;
    },
    {
      safeCount: 0,
      excludedCount: 0,
      attemptedCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      uncertainCount: 0,
      verifiedRestoredCount: 0,
      failedRestoreCount: 0,
      uncertainRestoreCount: 0,
      quotaUnits: 0
    }
  );
  return { ...accounting, verifiedProcessedCount: accounting.verifiedCount };
}

export function gmailScalableProgressLabel(status: GmailScalableJobStatus, job: {
  requestedCount: number;
  safeCount: number;
  excludedCount: number;
  attemptedCount: number;
  verifiedCount: number;
  verifiedRestoredCount: number;
}) {
  const activeChunk = "chunks" in job
    ? (job as GmailScalableJobView).chunks.find((chunk) => ["safety_checking", "ready", "mutating", "verifying", "undoing"].includes(chunk.status))
    : undefined;
  const chunkSuffix = activeChunk && (job as GmailScalableJobView).chunkCount > 1
    ? ` Chunk ${activeChunk.index + 1} of ${(job as GmailScalableJobView).chunkCount}.`
    : "";
  if (status === "chunk_complete" && "chunks" in job) {
    const progress = getGmailScalableJobProgress(job as GmailScalableJobView);
    const next = progress.nextChunk ? ` Preparing chunk ${progress.nextChunk} of ${(job as GmailScalableJobView).chunkCount}.` : "";
    return `${job.verifiedCount.toLocaleString("en-US")} messages moved so far.${next}`;
  }
  if (status === "safety_checking") return `Checking ${job.requestedCount.toLocaleString("en-US")} messages...${chunkSuffix}`;
  if (status === "ready") return `${job.safeCount.toLocaleString("en-US")} messages are ready to move.`;
  if (status === "mutating") return `Moving approved messages to Trash...${chunkSuffix}`;
  if (status === "verifying") return `Verifying approved messages...${chunkSuffix}`;
  if (status === "undoing") return `Restoring ${job.verifiedCount.toLocaleString("en-US")} messages...${chunkSuffix}`;
  if (status === "undo_complete") return `${job.verifiedRestoredCount.toLocaleString("en-US")} messages restored.`;
  if (status === "paused") return "Cleanup paused until Gmail quota is available.";
  if (status === "complete") {
    return `${job.requestedCount.toLocaleString("en-US")} checked; ${job.verifiedCount.toLocaleString("en-US")} moved to Trash.`;
  }
  const approvedCount = job.attemptedCount || job.safeCount;
  return `${job.verifiedCount.toLocaleString("en-US")} of ${approvedCount.toLocaleString("en-US")} approved messages processed`;
}

const terminalJobStatuses = new Set<GmailScalableJobStatus>([
  "complete",
  "partial",
  "uncertain",
  "failed",
  "undo_complete",
  "expired"
]);

const pollingJobStatuses = new Set<GmailScalableJobStatus>([
  "created",
  "safety_checking",
  "mutating",
  "verifying",
  "chunk_complete",
  "paused",
  "undoing"
]);

export function getGmailScalableJobProgress(job: GmailScalableJobView) {
  const chunksComplete = job.chunksComplete ?? job.chunks.filter((chunk) => ["complete", "undo_complete"].includes(chunk.status)).length;
  const next = job.chunks.find((chunk) =>
    ["pending", "safety_checking", "ready", "mutating", "verifying", "undoing"].includes(chunk.status)
  );
  const jobTerminal = terminalJobStatuses.has(job.status);
  return {
    jobTerminal,
    chunksComplete,
    nextChunk: next ? next.index + 1 : undefined,
    workflowContinuationExpected: !jobTerminal && pollingJobStatuses.has(job.status)
  };
}

export function shouldPollGmailScalableJob(job: GmailScalableJobView) {
  return getGmailScalableJobProgress(job).workflowContinuationExpected;
}

export function simulateGmailScalableJob(input: {
  targetCount: number;
  verifiedByChunk?: readonly number[];
  restoredByChunk?: readonly number[];
  stopAfterChunk?: number;
}) {
  const chunks = createGmailScalableChunkViews(input.targetCount);
  const completed: GmailScalableChunkView[] = [];
  for (const chunk of chunks) {
    if (input.stopAfterChunk !== undefined && chunk.index >= input.stopAfterChunk) break;
    const verifiedCount = input.verifiedByChunk?.[chunk.index] ?? chunk.targetCount;
    const uncertainCount = chunk.targetCount - verifiedCount;
    const verifiedRestoredCount = Math.min(verifiedCount, input.restoredByChunk?.[chunk.index] ?? 0);
    completed.push({
      ...chunk,
      status: uncertainCount ? "uncertain" : "complete",
      safeCount: chunk.targetCount,
      attemptedCount: chunk.targetCount,
      verifiedCount,
      uncertainCount,
      verifiedRestoredCount
    });
    if (uncertainCount) break;
  }
  return {
    chunkCount: chunks.length,
    completedChunkCount: completed.length,
    ...summarizeGmailScalableChunks(completed)
  };
}

export function simulateGmailQuotaPacing(input: {
  chunkCount: number;
  unitsPerChunk: number;
  workingBudget?: number;
}) {
  if (!Number.isInteger(input.chunkCount) || input.chunkCount < 1) throw new Error("Chunk count must be positive.");
  if (!Number.isInteger(input.unitsPerChunk) || input.unitsPerChunk < 0) throw new Error("Chunk units must be non-negative.");
  const workingBudget = input.workingBudget ?? gmailScalePolicy.workingUnitsPerMinute;
  if (input.unitsPerChunk > workingBudget) return { planningWindows: input.chunkCount, pausedDispatches: input.chunkCount };
  let budget = new GmailQuotaBudget(workingBudget);
  let planningWindows = 1;
  let pausedDispatches = 0;
  for (let index = 0; index < input.chunkCount; index += 1) {
    if (!budget.consume(input.unitsPerChunk)) {
      pausedDispatches += 1;
      planningWindows += 1;
      budget = new GmailQuotaBudget(workingBudget);
      budget.consume(input.unitsPerChunk);
    }
  }
  return { planningWindows, pausedDispatches };
}

export function formatGmailScalableDevelopmentSummary(job: GmailScalableJobView) {
  if (job.terminalDiagnostic) return job.terminalDiagnostic;
  const total = (key: keyof GmailScalableChunkView) =>
    job.chunks.reduce((sum, chunk) => sum + (typeof chunk[key] === "number" ? Number(chunk[key]) : 0), 0);
  const requestedAccounting = job.requestedCount === job.excludedCount + job.attemptedCount ? "PASS" : "NOT FINAL";
  const mutationAccounting = job.attemptedCount === job.verifiedCount + job.failedCount + job.uncertainCount
    ? "PASS"
    : "NOT FINAL";
  const progress = getGmailScalableJobProgress(job);
  const chunksComplete = progress.chunksComplete;
  const undoChunks = job.chunks.filter((chunk) => chunk.verifiedCount > 0).length;
  const undoUnits = total("undoQuotaUnits");
  const chunkSections = job.chunks.flatMap((chunk) => [
    `Chunk ${chunk.index + 1}`,
    `Checked: ${chunk.targetCount}`,
    `Safety excluded: ${chunk.excludedCount}`,
    `Approved: ${chunk.safeCount}`,
    `Attempted: ${chunk.attemptedCount}`,
    `Verified: ${chunk.verifiedCount}`,
    `Failed: ${chunk.failedCount}`,
    `Uncertain: ${chunk.uncertainCount}`,
    `Authoritative units: ${Math.max(0, chunk.quotaUnits - chunk.undoQuotaUnits)}`,
    `Personal list requests: ${chunk.personalListRequests}`,
    `batchModify requests: ${chunk.batchModifyRequests}`,
    `History requests: ${chunk.historyRequests}`,
    `History pages: ${chunk.historyPages}`,
    ""
  ]);
  return [
    "ORGANIZINBOX DEV SCALABLE CLEANUP SUMMARY",
    "",
    "Job",
    `Requested: ${job.requestedCount}`,
    `Chunk size: ${job.chunkSize}`,
    `Chunks: ${job.chunkCount}`,
    `Chunks complete: ${chunksComplete} / ${job.chunkCount}`,
    `Job terminal: ${progress.jobTerminal ? "yes" : "no"}`,
    `Next chunk: ${progress.nextChunk ?? "none"}`,
    "",
    "Workflow",
    `Chunk ${progress.nextChunk ?? job.chunkCount} scheduled: ${progress.workflowContinuationExpected ? "yes" : "no"}`,
    `Current durable state: ${job.status.toUpperCase()}`,
    "",
    ...chunkSections,
    "Job totals",
    `Checked: ${job.requestedCount}`,
    `Safety excluded: ${job.excludedCount}`,
    `Approved: ${job.safeCount}`,
    `Attempted: ${job.attemptedCount}`,
    `Verified: ${job.verifiedCount}`,
    `Failed: ${job.failedCount}`,
    `Uncertain: ${job.uncertainCount}`,
    "",
    "Safety",
    `Exact IMAP targets: ${job.requestedCount}`,
    `UIDVALIDITY valid: ${job.chunks.every((chunk) => chunk.uidValidityValid) ? "yes" : "not complete"}`,
    `ID matches: ${total("idMatchCount")}`,
    `Missing: ${total("missingCount")}`,
    `Starred excluded: ${total("starredExcludedCount")}`,
    `Important excluded: ${total("importantExcludedCount")}`,
    `Sent/Draft excluded: ${total("sentExcludedCount") + total("draftExcludedCount")}`,
    `Personal excluded: ${total("personalExcludedCount")}`,
    `Excluded before mutation: ${job.excludedCount}`,
    `Final approved: ${job.safeCount}`,
    "",
    "Quota",
    "IMAP recheck API units: 0",
    `Personal list requests: ${total("personalListRequests")}`,
    `Profile requests: ${total("profileRequests")}`,
    `Batch mutation requests: ${total("batchModifyRequests")}`,
    `History requests: ${total("historyRequests")}`,
    `Trash-list fallback requests: ${total("fallbackListRequests")}`,
    `GET fallback requests: ${total("getFallbackRequests")}`,
    `Authoritative cleanup units: ${Math.max(0, job.quotaConsumedUnits - undoUnits)}`,
    `Development audit units: ${job.developmentAuditQuotaUnits}`,
    "",
    "Mutation",
    `Attempted: ${job.attemptedCount}`,
    `batchModify requests: ${total("batchModifyRequests")}`,
    "",
    "Verification",
    `Verified: ${job.verifiedCount}`,
    `History verified: ${total("historyVerifiedCount")}`,
    `Trash-list verified: ${total("listVerifiedCount")}`,
    `GET verified: ${total("getVerifiedCount")}`,
    `Failed: ${job.failedCount}`,
    `Uncertain: ${job.uncertainCount}`,
    "",
    "Accounting",
    `Requested = Safety excluded + Attempted: ${requestedAccounting}`,
    `Attempted = Verified + Failed + Uncertain: ${mutationAccounting}`,
    "",
    "Completion",
    `Approved messages processed: ${job.verifiedProcessedCount} / ${job.attemptedCount}`,
    `Chunks complete: ${chunksComplete} / ${job.chunkCount}`,
    `Job result: ${job.status.toUpperCase()}`,
    "",
    "Performance",
    `IMAP recheck: ${total("imapMs")} ms`,
    `Personal reconciliation: ${total("personalMs")} ms`,
    `Mutation: ${total("mutationMs")} ms`,
    `History verification: ${total("verificationMs")} ms`,
    "",
    "Undo",
    `Eligible: ${job.undoAvailable ? "yes" : "no"}`,
    `Targets: ${job.verifiedCount}`,
    `Undo chunks: ${undoChunks}`,
    job.status === "undoing" ? "In progress" : job.status === "undo_complete" ? "Complete" : "Not started",
    `Bulk mutation requests: ${total("undoMutationRequests")}`,
    `History verified restored: ${total("undoHistoryVerifiedCount")}`,
    `Fallback restored: ${total("undoFallbackVerifiedCount")}`,
    `Failed: ${job.failedRestoreCount}`,
    `Uncertain: ${job.uncertainRestoreCount}`,
    `Undo units: ${undoUnits}`,
    "",
    "Recovery",
    `Verified moved ledger count: ${job.recoveryRestoreCount ?? 0}`,
    `Recovery restore available: ${job.recoveryRestoreAvailable ? "yes" : "no"}`,
    `Reason: ${job.recoveryRestoreReason ?? "No interrupted verified-move ledger is available."}`,
    "",
    "Transient state",
    `Present while Undo available: ${job.undoAvailable ? "yes" : "no"}`,
    "Deleted after terminal Undo: required",
    "",
    ...formatPostStateAudit(job.postStateAudit),
    "",
    "Safety",
    "Permanent delete used: no",
    "Message IDs persisted: no",
    "Bodies fetched: no",
    "Subjects persisted: no"
  ].join("\n");
}

export function getGmailScalableDiagnosticSnapshot(job: GmailScalableJobView) {
  const content = formatGmailScalableDevelopmentSummary(job);
  return { key: content, content };
}

function formatPostStateAudit(audit: GmailScalablePostStateAudit | undefined) {
  if (!audit) return ["Development post-state audit", "Disabled or not run"];
  const lines = ["Development post-state audit"];
  if (audit.cleanup) {
    lines.push(
      `Cleanup attempted messages: ${audit.cleanup.targetCount}`,
      `History verified messages: ${audit.cleanup.authoritativeHistoryVerifiedCount}`,
      `Exact target messages found in Trash: ${audit.cleanup.exactTargetMessagesFoundInTrash}`,
      `Exact target messages missing from Trash: ${audit.cleanup.exactTargetMessagesAbsentFromTrash}`,
      `Distinct Gmail threads for target messages: ${audit.cleanup.distinctGmailThreadCount}`,
      `Trash list requests: ${audit.cleanup.trashListRequests}`,
      `Trash list pages: ${audit.cleanup.trashListPages}`,
      `History vs Trash-state mismatch: ${audit.cleanup.mismatchCount}`
    );
    if (audit.cleanup.error) lines.push(`Cleanup audit status: ${audit.cleanup.error}`);
  }
  if (audit.undo) {
    lines.push(
      "",
      "Development Undo post-state audit",
      `Undo verified restored: ${audit.undo.targetCount}`,
      `Exact restored targets still found in Trash: ${audit.undo.exactTargetMessagesFoundInTrash}`,
      `Exact restored targets absent from Trash: ${audit.undo.exactTargetMessagesAbsentFromTrash}`,
      `Trash list requests: ${audit.undo.trashListRequests}`,
      `Trash list pages: ${audit.undo.trashListPages}`,
      `Undo history vs Trash-state mismatch: ${audit.undo.mismatchCount}`
    );
    if (audit.undo.error) lines.push(`Undo audit status: ${audit.undo.error}`);
  }
  return lines;
}

function emptyChunk(index: number, targetCount: number): GmailScalableChunkView {
  return {
    index,
    status: "pending",
    targetCount,
    preflightCheckedCount: 0,
    preflightSafeCount: 0,
    preflightExcludedCount: 0,
    safeCount: 0,
    excludedCount: 0,
    attemptedCount: 0,
    verifiedCount: 0,
    failedCount: 0,
    uncertainCount: 0,
    historyVerifiedCount: 0,
    listVerifiedCount: 0,
    getVerifiedCount: 0,
    getFallbackRequests: 0,
    retryCount: 0,
    quotaUnits: 0,
    uidValidityValid: false,
    idMatchCount: 0,
    missingCount: 0,
    identityMismatchCount: 0,
    starredExcludedCount: 0,
    importantExcludedCount: 0,
    sentExcludedCount: 0,
    draftExcludedCount: 0,
    personalExcludedCount: 0,
    personalListRequests: 0,
    profileRequests: 0,
    batchModifyRequests: 0,
    historyRequests: 0,
    historyPages: 0,
    fallbackListRequests: 0,
    fallbackListPages: 0,
    imapMs: 0,
    personalMs: 0,
    mutationMs: 0,
    verificationMs: 0,
    undoMutationRequests: 0,
    undoHistoryVerifiedCount: 0,
    undoFallbackVerifiedCount: 0,
    undoQuotaUnits: 0,
    verifiedRestoredCount: 0,
    failedRestoreCount: 0,
    uncertainRestoreCount: 0
  };
}
