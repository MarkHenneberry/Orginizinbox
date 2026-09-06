export const outlookCleanupMaximum = 500;
export const outlookCleanupCountOptions = [5, 10, 25, 500] as const;
export const outlookCleanupChunkSize = 100;

export function getOutlookCleanupBatchSize(requested: number) {
  if (requested <= 25) return 5;
  if (requested <= 100) return 10;
  return 20;
}

export function getOutlookCleanupTotalBatches(requested: number, targetCount = requested) {
  return Math.ceil(targetCount / getOutlookCleanupBatchSize(requested));
}

export function getOutlookCleanupBatchesPerChunk(requested: number) {
  return Math.ceil(outlookCleanupChunkSize / getOutlookCleanupBatchSize(requested));
}

export const outlookCleanupStatuses = [
  "created",
  "resolving",
  "ready",
  "running",
  "complete",
  "partial",
  "uncertain",
  "undoing",
  "undo_complete",
  "failed",
  "expired"
] as const;

export type OutlookCleanupStatus = (typeof outlookCleanupStatuses)[number];
export type OutlookCleanupUndoStatus = "not_available" | "available" | "running" | "complete" | "partial" | "uncertain";

export type OutlookCleanupTimingMs = {
  preflight: number;
  finalRecheck: number;
  move: number;
  verification: number;
  undoMove: number;
  undoVerification: number;
};

export type OutlookCleanupHttpRoundTrips = OutlookCleanupTimingMs;

export type OutlookCleanupJobView = {
  provider: "microsoft";
  id: string;
  status: OutlookCleanupStatus;
  requested: number;
  approved: number;
  excludedBySafety: number;
  movedVerified: number;
  restoredVerified: number;
  failed: number;
  uncertain: number;
  checked: number;
  chunksCompleted: number;
  totalChunks: number;
  batchesCompleted: number;
  totalBatches: number;
  currentChunk: number;
  currentBatch: number;
  effectiveBatchSize: number;
  undoBatchesCompleted: number;
  undoTotalBatches: number;
  graphRequests: number;
  httpRoundTrips: number;
  graphSubrequests: number;
  retries: number;
  httpRoundTripsByPhase: OutlookCleanupHttpRoundTrips;
  timingMs: OutlookCleanupTimingMs;
  groupIndices: number[];
  undoAvailable: boolean;
  undoStatus: OutlookCleanupUndoStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export function createEmptyOutlookCleanupTiming(): OutlookCleanupTimingMs {
  return {
    preflight: 0,
    finalRecheck: 0,
    move: 0,
    verification: 0,
    undoMove: 0,
    undoVerification: 0
  };
}

export function createEmptyOutlookCleanupHttpRoundTrips(): OutlookCleanupHttpRoundTrips {
  return createEmptyOutlookCleanupTiming();
}

export function isOutlookCleanupDevelopmentEnabled(input: {
  microsoftOAuthEnabled: boolean;
  outlookCleanupEnabled: boolean;
  fixtureMode: boolean;
  nodeEnv: string | undefined;
}) {
  return input.microsoftOAuthEnabled &&
    input.outlookCleanupEnabled &&
    !input.fixtureMode &&
    input.nodeEnv !== "production";
}

export function assertOutlookCleanupDevelopmentRequest(input: {
  enabled: boolean;
  fixtureMode: boolean;
  nodeEnv: string | undefined;
  requestedCount: unknown;
}) {
  if (!input.enabled || input.fixtureMode || input.nodeEnv === "production") {
    throw new Error("Outlook cleanup is disabled.");
  }
  if (
    !Number.isInteger(input.requestedCount) ||
    Number(input.requestedCount) < 1 ||
    Number(input.requestedCount) > outlookCleanupMaximum
  ) {
    throw new Error(`Outlook cleanup accepts between 1 and ${outlookCleanupMaximum} messages.`);
  }
  return Number(input.requestedCount);
}

export function shouldPollOutlookCleanup(job: OutlookCleanupJobView) {
  return ["created", "resolving", "running", "undoing"].includes(job.status);
}

export function formatOutlookCleanupDiagnostic(job: OutlookCleanupJobView) {
  return [
    "ORGANIZINBOX DEV OUTLOOK CLEANUP SUMMARY",
    "",
    `Requested: ${job.requested}`,
    `Checked: ${job.checked}`,
    `Approved: ${job.approved}`,
    `Excluded by safety: ${job.excludedBySafety}`,
    `Moved/verified: ${job.movedVerified}`,
    `Restored/verified: ${job.restoredVerified}`,
    `Failed: ${job.failed}`,
    `Uncertain: ${job.uncertain}`,
    `Effective batch size: ${job.effectiveBatchSize}`,
    `Chunks completed: ${job.chunksCompleted}/${job.totalChunks}`,
    `Batches completed: ${job.batchesCompleted}/${job.totalBatches}`,
    `Current chunk: ${job.currentChunk}`,
    `Current batch: ${job.currentBatch}`,
    `Undo batches completed: ${job.undoBatchesCompleted}/${job.undoTotalBatches}`,
    `HTTP round trips: ${job.httpRoundTrips ?? job.graphRequests}`,
    `Preflight HTTP round trips: ${job.httpRoundTripsByPhase?.preflight ?? 0}`,
    `Final recheck HTTP round trips: ${job.httpRoundTripsByPhase?.finalRecheck ?? 0}`,
    `Move HTTP round trips: ${job.httpRoundTripsByPhase?.move ?? 0}`,
    `Verification HTTP round trips: ${job.httpRoundTripsByPhase?.verification ?? 0}`,
    `Undo move HTTP round trips: ${job.httpRoundTripsByPhase?.undoMove ?? 0}`,
    `Undo verification HTTP round trips: ${job.httpRoundTripsByPhase?.undoVerification ?? 0}`,
    `Graph subrequests: ${job.graphSubrequests ?? job.graphRequests}`,
    `Retries: ${job.retries}`,
    "",
    "Timing",
    `Preflight: ${job.timingMs?.preflight ?? 0} ms`,
    `Final recheck: ${job.timingMs?.finalRecheck ?? 0} ms`,
    `Move: ${job.timingMs?.move ?? 0} ms`,
    `Verification: ${job.timingMs?.verification ?? 0} ms`,
    `Undo move: ${job.timingMs?.undoMove ?? 0} ms`,
    `Undo verification: ${job.timingMs?.undoVerification ?? 0} ms`,
    "",
    `Job status: ${job.status}`,
    `Undo status: ${job.undoStatus}`
  ].join("\n");
}
