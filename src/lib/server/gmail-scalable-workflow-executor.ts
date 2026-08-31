import "server-only";
import { runtimeConfig } from "@/lib/config";
import {
  gmailScalableProgressLabel,
  summarizeGmailScalableChunks,
  type GmailScalableJobStatus
} from "@/lib/domain/gmail-scalable-cleanup";
import type { GmailScalableWorkflowOperation } from "@/lib/domain/gmail-scalable-workflow";
import {
  GmailScalableCleanupProvider,
  GmailScalableQuotaPauseError,
  type GmailScalableCleanupProviderPort,
  type GmailScalableQuotaRequestKind
} from "@/lib/providers/gmail/scalable-cleanup-provider";
import { gmailScalePolicy, gmailScaleQuotaUnits } from "@/lib/providers/gmail/scale-architecture";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { markLiveReportStale } from "@/lib/server/live-scan-store";
import type { GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";
import type { GmailScalableWorkflowOperationExecutor } from "@/lib/server/gmail-scalable-workflow-coordinator";
import { GmailScalableWorkflowFixtureProvider } from "@/lib/server/gmail-scalable-workflow-fixture-provider";

const quotaWindowMs = 60_000;

export class GmailScalableProviderWorkflowExecutor implements GmailScalableWorkflowOperationExecutor {
  constructor(
    private readonly providerForJob: (job: GmailScalableStoredJob) => Promise<GmailScalableCleanupProviderPort> = createProvider,
    private readonly now: () => number = Date.now
  ) {}

  async execute(input: { job: GmailScalableStoredJob; operation: GmailScalableWorkflowOperation }) {
    const job = structuredClone(input.job);
    try {
      restorePausedState(job);
      const provider = await this.providerForJob(job);
      const reserve = createQuotaReservation(job, this.now);
      switch (input.operation) {
        case "preflight_safety":
          await runPreflightSafetyCheck(job, provider, reserve, this.now());
          break;
        case "safety_check":
          await runSafetyCheck(job, provider, reserve, this.now());
          break;
        case "checkpoint_trash":
          activeSensitiveChunk(job).historyCheckpoint = await provider.captureHistoryCheckpoint(reserve);
          job.view.chunks[activeSensitiveChunk(job).index].profileRequests += 1;
          break;
        case "dispatch_trash":
          await provider.moveToTrash(activeSafeTargetIds(job), reserve);
          if (!job.payload.fixture?.enabled) markLiveReportStale(job.userId);
          setActiveChunkStatus(job, "verifying");
          setJobStatus(job, "verifying", this.now());
          break;
        case "verify_trash":
          await verifyTrash(job, provider, reserve, this.now());
          break;
        case "advance_chunk":
          advanceChunk(job, this.now());
          break;
        case "checkpoint_undo":
          activeUndoChunk(job).undoHistoryCheckpoint = await provider.captureHistoryCheckpoint(reserve);
          job.view.chunks[activeUndoChunk(job).index].profileRequests += 1;
          break;
        case "dispatch_undo":
          await provider.removeTrashLabel(activeUndoTargetIds(job), reserve);
          if (!job.payload.fixture?.enabled) markLiveReportStale(job.userId);
          break;
        case "verify_undo":
          await verifyUndo(job, provider, reserve, this.now());
          break;
      }
      job.payload.resumeState = undefined;
      return refreshJob(job, this.now());
    } catch (error) {
      if (!(error instanceof GmailScalableQuotaPauseError)) throw error;
      job.payload.resumeState = resumeStateFor(input.operation);
      job.view.status = "paused";
      job.view.nextEligibleRunAt = error.nextEligibleRunAt;
      return refreshJob(job, this.now());
    }
  }
}

async function runPreflightSafetyCheck(
  job: GmailScalableStoredJob,
  provider: GmailScalableCleanupProviderPort,
  reserve: (kind: GmailScalableQuotaRequestKind) => Promise<void>,
  now: number
) {
  const sensitive = job.payload.chunks.find((chunk) => !chunk.preflightComplete);
  if (!sensitive) throw new Error("No cleanup chunk is available for preflight.");
  const chunk = job.view.chunks[sensitive.index];
  job.view.status = "safety_checking";
  chunk.status = "safety_checking";
  const result = await provider.runSafetyCheck({
    uidValidity: job.payload.uidValidity,
    targets: sensitive.targets,
    reserve
  });
  sensitive.preflightComplete = true;
  Object.assign(chunk, {
    status: "ready",
    preflightCheckedCount: sensitive.targets.length,
    preflightSafeCount: result.safeTargets.length,
    preflightExcludedCount: sensitive.targets.length - result.safeTargets.length,
    safeCount: result.safeTargets.length,
    excludedCount: sensitive.targets.length - result.safeTargets.length,
    uidValidityValid: true,
    idMatchCount: sensitive.targets.length - result.missingCount - result.identityMismatchCount,
    missingCount: result.missingCount,
    identityMismatchCount: result.identityMismatchCount,
    starredExcludedCount: result.starredCount,
    importantExcludedCount: result.importantCount,
    sentExcludedCount: result.sentCount,
    draftExcludedCount: result.draftCount,
    personalExcludedCount: result.personalCount,
    personalListRequests: chunk.personalListRequests + result.personalListRequests,
    retryCount: chunk.retryCount + result.retryCount,
    imapMs: chunk.imapMs + result.imapMs,
    personalMs: chunk.personalMs + result.personalMs
  });
  if (job.payload.chunks.some((candidate) => !candidate.preflightComplete)) {
    setJobStatus(job, "safety_checking", now);
    return;
  }
  if (job.payload.fixture?.enabled && job.payload.fixture.autoConfirm) {
    prepareGmailScalableJobForConfirmedCleanup(job, now);
    return;
  }
  setJobStatus(job, "ready", now);
}

export function prepareGmailScalableJobForConfirmedCleanup(job: GmailScalableStoredJob, now: number) {
  job.payload.confirmedAt = now;
  job.view.undoAvailable = false;
  job.view.completedAt = undefined;
  for (const sensitive of job.payload.chunks) {
    sensitive.safeTargetIndexes = [];
    sensitive.verifiedMovedIndexes = [];
    sensitive.historyCheckpoint = undefined;
    sensitive.trashMutationDispatched = undefined;
    const chunk = job.view.chunks[sensitive.index];
    Object.assign(chunk, {
      status: "pending",
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
      uidValidityValid: false,
      idMatchCount: 0,
      missingCount: 0,
      identityMismatchCount: 0,
      starredExcludedCount: 0,
      importantExcludedCount: 0,
      sentExcludedCount: 0,
      draftExcludedCount: 0,
      personalExcludedCount: 0,
      completedAt: undefined
    });
  }
  job.view.chunks[0].status = "safety_checking";
  setJobStatus(job, "safety_checking", now);
  return refreshJob(job, now);
}

function restorePausedState(job: GmailScalableStoredJob) {
  if (job.view.status !== "paused" || !job.payload.resumeState) return;
  job.view.status = job.payload.resumeState;
  job.view.nextEligibleRunAt = undefined;
}

async function createProvider(job: GmailScalableStoredJob) {
  if (
    process.env.NODE_ENV !== "production" &&
    runtimeConfig.fixtureMode &&
    runtimeConfig.gmailScalableWorkflowFixtureEnabled &&
    job.payload.fixture?.enabled
  ) {
    return new GmailScalableWorkflowFixtureProvider(job);
  }
  const connection = await getActiveGmailConnection(job.userId);
  if (!connection) throw new Error("An active Gmail connection is required for scalable cleanup.");
  return new GmailScalableCleanupProvider(connection.accessToken, connection.accountEmail);
}

async function runSafetyCheck(
  job: GmailScalableStoredJob,
  provider: GmailScalableCleanupProviderPort,
  reserve: (kind: GmailScalableQuotaRequestKind) => Promise<void>,
  now: number
) {
  const sensitive = job.payload.chunks.find((chunk) => job.view.chunks[chunk.index]?.status === "safety_checking")
    ?? job.payload.chunks.find((chunk) => job.view.chunks[chunk.index]?.status === "pending");
  if (!sensitive) throw new Error("No cleanup chunk is available for its safety check.");
  job.view.status = "safety_checking";
  job.view.chunks[sensitive.index].status = "safety_checking";
  const result = await provider.runSafetyCheck({
    uidValidity: job.payload.uidValidity,
    targets: sensitive.targets,
    reserve
  });
  const safeIds = new Set(result.safeTargets.map((target) => target.apiMessageId));
  sensitive.safeTargetIndexes = sensitive.targets.flatMap((target, index) => safeIds.has(target.apiMessageId) ? [index] : []);
  const chunk = job.view.chunks[sensitive.index];
  Object.assign(chunk, {
    status: result.safeTargets.length ? "ready" : "complete",
    safeCount: result.safeTargets.length,
    excludedCount: sensitive.targets.length - result.safeTargets.length,
    uidValidityValid: true,
    idMatchCount: sensitive.targets.length - result.missingCount - result.identityMismatchCount,
    missingCount: result.missingCount,
    identityMismatchCount: result.identityMismatchCount,
    starredExcludedCount: result.starredCount,
    importantExcludedCount: result.importantCount,
    sentExcludedCount: result.sentCount,
    draftExcludedCount: result.draftCount,
    personalExcludedCount: result.personalCount,
    personalListRequests: chunk.personalListRequests + result.personalListRequests,
    retryCount: chunk.retryCount + result.retryCount,
    imapMs: chunk.imapMs + result.imapMs,
    personalMs: chunk.personalMs + result.personalMs
  });
  if (result.safeTargets.length) {
    const priorChunkComplete = job.view.chunks.some((candidate) => candidate.index < chunk.index && candidate.status === "complete");
    const wholeJobConfirmed = Boolean(job.payload.confirmedAt);
    chunk.status = priorChunkComplete || wholeJobConfirmed ? "mutating" : "ready";
    if (chunk.status === "mutating") chunk.startedAt ??= now;
    setJobStatus(job, priorChunkComplete || wholeJobConfirmed ? "mutating" : "ready", now);
  } else {
    chunk.completedAt = now;
    setJobStatus(job, "chunk_complete", now);
  }
}

async function verifyTrash(
  job: GmailScalableStoredJob,
  provider: GmailScalableCleanupProviderPort,
  reserve: (kind: GmailScalableQuotaRequestKind) => Promise<void>,
  now: number
) {
  const sensitive = activeSensitiveChunk(job);
  if (!sensitive.historyCheckpoint || !sensitive.trashMutationDispatched) {
    throw new Error("Trash verification requires a durable checkpoint and dispatch marker.");
  }
  const targetIds = activeSafeTargetIds(job);
  const result = await provider.verifyTrash({ targetIds, startHistoryId: sensitive.historyCheckpoint, reserve });
  assertVerificationAccounting(targetIds, result);
  const verified = new Set(result.verifiedIds);
  sensitive.verifiedMovedIndexes = sensitive.targets.flatMap((target, index) => verified.has(target.apiMessageId) ? [index] : []);
  const chunk = job.view.chunks[sensitive.index];
  Object.assign(chunk, {
    status: result.uncertainIds.length ? "uncertain" : result.failedIds.length ? "partial" : "complete",
    attemptedCount: targetIds.length,
    verifiedCount: result.verifiedIds.length,
    failedCount: result.failedIds.length,
    uncertainCount: result.uncertainIds.length,
    historyVerifiedCount: result.historyVerifiedCount,
    listVerifiedCount: result.listVerifiedCount,
    getVerifiedCount: result.getVerifiedCount,
    getFallbackRequests: result.getFallbackRequests,
    historyRequests: result.historyRequests,
    historyPages: result.historyPages,
    fallbackListRequests: result.listRequests,
    fallbackListPages: result.listPages,
    verificationMs: result.durationMs,
    retryCount: chunk.retryCount + result.retryCount,
    completedAt: now
  });
  job.view.suggestedDeltas = addGroupDeltas(job.view.suggestedDeltas, safeTargetsByGroup(sensitive, verified), "moved");
  setJobStatus(job, result.uncertainIds.length ? "uncertain" : result.failedIds.length ? "partial" : "chunk_complete", now);
  if (job.payload.fixture?.enabled && result.verifiedIds.length > 0) {
    job.payload.fixture.verifiedProgress.push(
      job.view.chunks.reduce((total, candidate) => total + candidate.verifiedCount, 0)
    );
  }
}

function advanceChunk(job: GmailScalableStoredJob, now: number) {
  const next = job.view.chunks.find((chunk) => chunk.status === "pending");
  if (next) {
    next.status = "safety_checking";
    setJobStatus(job, "safety_checking", now);
    return;
  }
  const allVerified = job.view.chunks.every((chunk) =>
    chunk.status === "complete" && chunk.failedCount === 0 && chunk.uncertainCount === 0
  );
  job.view.undoAvailable = allVerified && job.view.chunks.some((chunk) => chunk.verifiedCount > 0);
  setJobStatus(job, allVerified ? "complete" : "partial", now);
}

async function verifyUndo(
  job: GmailScalableStoredJob,
  provider: GmailScalableCleanupProviderPort,
  reserve: (kind: GmailScalableQuotaRequestKind) => Promise<void>,
  now: number
) {
  const sensitive = activeUndoChunk(job);
  if (!sensitive.undoHistoryCheckpoint || !sensitive.undoMutationDispatched) {
    throw new Error("Undo verification requires a durable checkpoint and dispatch marker.");
  }
  const targetIds = activeUndoTargetIds(job);
  const result = await provider.verifyTrashRemoval({ targetIds, startHistoryId: sensitive.undoHistoryCheckpoint, reserve });
  assertVerificationAccounting(targetIds, result);
  const verified = new Set(result.verifiedIds);
  sensitive.verifiedRestoredIndexes = sensitive.targets.flatMap((target, index) => verified.has(target.apiMessageId) ? [index] : []);
  const chunk = job.view.chunks[sensitive.index];
  Object.assign(chunk, {
    status: result.uncertainIds.length ? "uncertain" : result.failedIds.length ? "partial" : "undo_complete",
    verifiedRestoredCount: result.verifiedIds.length,
    failedRestoreCount: result.failedIds.length,
    uncertainRestoreCount: result.uncertainIds.length,
    undoHistoryVerifiedCount: result.historyVerifiedCount,
    undoFallbackVerifiedCount: result.listVerifiedCount + result.getVerifiedCount,
    undoQuotaUnits: Math.max(
      0,
      job.view.quotaConsumedUnits - (job.payload.undoQuotaStartUnits ?? job.view.quotaConsumedUnits) -
        job.view.chunks.reduce((total, candidate) => total + (candidate.index === chunk.index ? 0 : candidate.undoQuotaUnits), 0)
    ),
    completedAt: now
  });
  job.view.suggestedDeltas = addGroupDeltas(job.view.suggestedDeltas, safeTargetsByGroup(sensitive, verified), "restored");
  const hasMore = job.payload.chunks.some(
    (candidate) => candidate.verifiedMovedIndexes.length > 0 && candidate.verifiedRestoredIndexes.length === 0
  );
  setJobStatus(
    job,
    result.uncertainIds.length ? "uncertain" : result.failedIds.length ? "partial" : hasMore ? "undoing" : "undo_complete",
    now
  );
  if (job.payload.fixture?.enabled && result.verifiedIds.length > 0) {
    job.payload.fixture.restoredProgress.push(
      job.view.chunks.reduce((total, candidate) => total + candidate.verifiedRestoredCount, 0)
    );
  }
}

function createQuotaReservation(job: GmailScalableStoredJob, now: () => number) {
  return async (kind: GmailScalableQuotaRequestKind) => {
    const current = now();
    if (current - job.payload.quotaWindow.startedAt >= quotaWindowMs) {
      job.payload.quotaWindow = { startedAt: current, consumedUnits: 0 };
    }
    const units = gmailScaleQuotaUnits[kind];
    if (job.payload.quotaWindow.consumedUnits + units > gmailScalePolicy.workingUnitsPerMinute) {
      throw new GmailScalableQuotaPauseError(job.payload.quotaWindow.startedAt + quotaWindowMs);
    }
    job.payload.quotaWindow.consumedUnits += units;
    job.view.quotaConsumedUnits += units;
    const chunkIndex = activeQuotaChunkIndex(job);
    job.view.chunks[chunkIndex].quotaUnits += units;
  };
}

function activeQuotaChunkIndex(job: GmailScalableStoredJob) {
  if (job.view.status === "undoing") return activeUndoChunk(job).index;
  const active = job.view.chunks.find((chunk) => ["safety_checking", "mutating", "verifying"].includes(chunk.status));
  if (active) return active.index;
  const pending = job.view.chunks.find((chunk) => chunk.status === "pending");
  if (pending) return pending.index;
  throw new Error("No active scalable cleanup chunk exists for quota accounting.");
}

function activeSensitiveChunk(job: GmailScalableStoredJob) {
  const chunk = job.payload.chunks.find((candidate) =>
    ["mutating", "verifying"].includes(job.view.chunks[candidate.index]?.status)
  );
  if (!chunk) throw new Error("No active cleanup chunk exists.");
  return chunk;
}

function activeUndoChunk(job: GmailScalableStoredJob) {
  const chunk = job.payload.chunks.find(
    (candidate) => candidate.verifiedMovedIndexes.length > 0 && candidate.verifiedRestoredIndexes.length === 0
  );
  if (!chunk) throw new Error("No exact verified-moved Undo chunk exists.");
  return chunk;
}

function activeSafeTargetIds(job: GmailScalableStoredJob) {
  const chunk = activeSensitiveChunk(job);
  return chunk.safeTargetIndexes.map((index) => {
    const target = chunk.targets[index];
    if (!target) throw new Error("The cleanup target ledger is invalid.");
    return target.apiMessageId;
  });
}

function activeUndoTargetIds(job: GmailScalableStoredJob) {
  const chunk = activeUndoChunk(job);
  return chunk.verifiedMovedIndexes.map((index) => {
    const target = chunk.targets[index];
    if (!target) throw new Error("The Undo target ledger is invalid.");
    return target.apiMessageId;
  });
}

function setActiveChunkStatus(job: GmailScalableStoredJob, status: "verifying") {
  job.view.chunks[activeSensitiveChunk(job).index].status = status;
}

function setJobStatus(job: GmailScalableStoredJob, status: GmailScalableJobStatus, now: number) {
  job.view.status = status;
  job.view.updatedAt = now;
  if (["complete", "partial", "uncertain", "failed", "undo_complete"].includes(status)) job.view.completedAt = now;
}

function refreshJob(job: GmailScalableStoredJob, now: number) {
  const { quotaUnits: _quotaUnits, ...summary } = summarizeGmailScalableChunks(job.view.chunks);
  void _quotaUnits;
  Object.assign(job.view, summary, { updatedAt: now });
  job.view.progressLabel = gmailScalableProgressLabel(job.view.status, job.view);
  return job;
}

function resumeStateFor(operation: GmailScalableWorkflowOperation) {
  if (operation === "safety_check") return "safety_checking" as const;
  if (operation === "verify_trash") return "verifying" as const;
  if (["checkpoint_undo", "dispatch_undo", "verify_undo"].includes(operation)) return "undoing" as const;
  return "mutating" as const;
}

function assertVerificationAccounting(
  targetIds: readonly string[],
  result: { verifiedIds: readonly string[]; failedIds: readonly string[]; uncertainIds: readonly string[] }
) {
  const outcomes = [...result.verifiedIds, ...result.failedIds, ...result.uncertainIds];
  if (outcomes.length !== targetIds.length || new Set(outcomes).size !== targetIds.length) {
    throw new Error("Gmail verification accounting is invalid.");
  }
}

function safeTargetsByGroup(
  chunk: GmailScalableStoredJob["payload"]["chunks"][number],
  ids: ReadonlySet<string>
) {
  const counts = new Map<number, number>();
  for (const target of chunk.targets) {
    if (ids.has(target.apiMessageId)) counts.set(target.groupIndex, (counts.get(target.groupIndex) ?? 0) + 1);
  }
  return counts;
}

function addGroupDeltas(
  existing: GmailScalableStoredJob["view"]["suggestedDeltas"],
  counts: ReadonlyMap<number, number>,
  direction: "moved" | "restored"
) {
  const merged = new Map(existing.map((delta) => [delta.groupIndex, { ...delta }]));
  for (const [groupIndex, count] of counts) {
    const delta = merged.get(groupIndex) ?? { groupIndex, verifiedMovedCount: 0, verifiedRestoredCount: 0 };
    if (direction === "moved") delta.verifiedMovedCount += count;
    else delta.verifiedRestoredCount += count;
    merged.set(groupIndex, delta);
  }
  return [...merged.values()].sort((left, right) => left.groupIndex - right.groupIndex);
}
