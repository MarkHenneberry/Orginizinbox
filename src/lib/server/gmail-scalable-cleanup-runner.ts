import "server-only";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "@/lib/config";
import { getGmailCleanupRequestMode } from "@/lib/domain/gmail-cleanup-request-mode";
import {
  assertGmailScalableTransition,
  assertGmailScalableDevelopmentGate,
  createGmailScalableChunkViews,
  gmailScalableCleanupDevMaximum,
  gmailScalableProgressLabel,
  isGmailScalablePostStateAuditEnabled,
  summarizeGmailScalableChunks,
  type GmailScalablePostStateAuditPhase,
  type GmailScalableJobStatus,
  type GmailScalableJobView,
  type GmailScalableSuggestedDelta
} from "@/lib/domain/gmail-scalable-cleanup";
import {
  buildCleanupSenderGroups,
  type CleanupSenderGroup
} from "@/lib/providers/gmail/cleanup-candidates";
import {
  GmailScalableCleanupProvider,
  GmailScalableQuotaPauseError,
  type GmailScalableCleanupProviderPort,
  type GmailScalableQuotaRequestKind
} from "@/lib/providers/gmail/scalable-cleanup-provider";
import { gmailScalePolicy, gmailScaleQuotaUnits } from "@/lib/providers/gmail/scale-architecture";
import {
  allocateGmailScalableCleanupTargets,
  type GmailScalableCleanupTarget
} from "@/lib/providers/gmail/scalable-targets";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { getLiveScan, markLiveReportStale } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";
import { sha256Base64Url } from "@/lib/server/crypto";
import {
  gmailScalableCleanupStore,
  serializeGmailScalableJob,
  type GmailScalableCleanupStore,
  type GmailScalableSensitivePayload,
  type GmailScalableStoredJob
} from "@/lib/server/gmail-scalable-cleanup-store";

const scalableJobTtlMs = 30 * 60 * 1000;
const quotaWindowMs = 60 * 1000;

export class GmailScalableCleanupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "GmailScalableCleanupError";
  }
}

type RunnerDependencies = {
  store: GmailScalableCleanupStore;
  providerForUser(userId: string): Promise<GmailScalableCleanupProviderPort>;
  validateContext(userId: string, scanId: string, groupIndices: readonly number[]): void | Promise<void>;
  onMutationAttempted(userId: string): void;
  now(): number;
  schedule(work: () => Promise<void>, delayMs: number): void;
  acceptanceHash(value: string): string;
  postStateAuditEnabled: boolean;
};

export class CleanupJobRunner {
  constructor(private readonly dependencies: RunnerDependencies) {}

  accept(input: {
    userId: string;
    scanId: string;
    uidValidity: string;
    requestedCount: number;
    groupIndices: readonly number[];
    groups: readonly CleanupSenderGroup[];
    targets: readonly GmailScalableCleanupTarget[];
  }) {
    assertDevelopmentGate(input.requestedCount);
    const groupIndices = parseGroupIndices(input.groupIndices);
    const acceptanceKey = this.dependencies.acceptanceHash(
      JSON.stringify([input.scanId, [...groupIndices].sort((a, b) => a - b), input.requestedCount])
    );
    const existing = this.dependencies.store.findActive(input.userId, acceptanceKey);
    if (existing) {
      const reused = this.dependencies.store.compareAndSet(input.userId, existing.view.id, existing.version, (job) => ({
        ...job,
        view: { ...job.view, duplicateStartCount: job.view.duplicateStartCount + 1 }
      }));
      return serializeGmailScalableJob(reused ?? existing);
    }

    const selectedGroups = groupIndices.map((index) => input.groups[index]);
    if (selectedGroups.some((group) => !group?.eligible)) {
      throw new GmailScalableCleanupError("Every selected sender group must still be eligible for cleanup.", 409);
    }
    const allocatedTargets = allocateGmailScalableCleanupTargets(selectedGroups, input.targets, input.requestedCount);
    if (allocatedTargets.length !== input.requestedCount) {
      throw new GmailScalableCleanupError(`The fresh scan no longer contains ${input.requestedCount} exact Suggested messages for this selection.`, 409);
    }

    const now = this.dependencies.now();
    const chunks = createGmailScalableChunkViews(allocatedTargets.length);
    const payload: GmailScalableSensitivePayload = {
      scanId: input.scanId,
      uidValidity: input.uidValidity,
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        targets: allocatedTargets.slice(chunk.index * gmailScalePolicy.mutationChunkSize, (chunk.index + 1) * gmailScalePolicy.mutationChunkSize),
        safeTargetIndexes: [],
        verifiedMovedIndexes: [],
        verifiedRestoredIndexes: []
      })),
      quotaWindow: { startedAt: now, consumedUnits: 0 }
    };
    const view: GmailScalableJobView = refreshView({
      id: randomUUID(),
      status: "created",
      requestedCount: input.requestedCount,
      chunkSize: gmailScalePolicy.mutationChunkSize,
      chunkCount: chunks.length,
      safeCount: 0,
      excludedCount: 0,
      attemptedCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      uncertainCount: 0,
      verifiedRestoredCount: 0,
      failedRestoreCount: 0,
      uncertainRestoreCount: 0,
      verifiedProcessedCount: 0,
      progressLabel: "Cleanup accepted.",
      quotaConsumedUnits: 0,
      developmentAuditQuotaUnits: 0,
      quotaWorkingLimit: gmailScalePolicy.workingUnitsPerMinute,
      suggestedDeltas: [],
      groupIndices: [...groupIndices],
      chunks,
      undoAvailable: false,
      duplicateStartCount: 0,
      duplicateDispatchCount: 0,
      duplicateUndoCount: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + scalableJobTtlMs
    });
    const stored = this.dependencies.store.create({
      userId: input.userId,
      acceptanceKey,
      version: 0,
      view,
      payload
    });
    this.scheduleSafety(input.userId, stored.view.id);
    return serializeGmailScalableJob(stored);
  }

  getStatus(userId: string, jobId: string) {
    const job = this.requireJob(userId, jobId);
    return serializeGmailScalableJob(job);
  }

  getLatest(userId: string) {
    const job = this.dependencies.store.findLatest(userId);
    return job ? serializeGmailScalableJob(job) : undefined;
  }

  confirm(userId: string, jobId: string) {
    const current = this.requireJob(userId, jobId);
    if (current.view.status !== "ready") {
      if (["mutating", "verifying", "chunk_complete", "complete"].includes(current.view.status)) {
        return serializeGmailScalableJob(this.incrementDuplicate(current, "duplicateDispatchCount"));
      }
      throw new GmailScalableCleanupError("This scalable cleanup job is not ready to move messages.", 409);
    }
    const claimed = this.transition(current, "mutating", (job) => {
      const chunkIndex = nextChunkIndex(job, "ready");
      job.view.chunks[chunkIndex] = { ...job.view.chunks[chunkIndex], status: "mutating", startedAt: this.dependencies.now() };
      return job;
    });
    this.scheduleMutation(userId, jobId);
    return serializeGmailScalableJob(claimed);
  }

  undo(userId: string, jobId: string) {
    const current = this.requireJob(userId, jobId);
    if (current.view.status === "undoing" || current.view.status === "undo_complete") {
      return serializeGmailScalableJob(this.incrementDuplicate(current, "duplicateUndoCount"));
    }
    if (current.view.status !== "complete" || !current.view.undoAvailable || !hasExactVerifiedMovedLedger(current)) {
      throw new GmailScalableCleanupError("Scalable Undo requires every attempted message to be verified in Trash and its exact Undo ledger to remain available.", 409);
    }
    const claimed = this.transition(current, "undoing", (job) => {
      job.view.undoAvailable = false;
      job.payload.undoQuotaStartUnits = job.view.quotaConsumedUnits;
      job.view.chunks = job.view.chunks.map((chunk) => ({ ...chunk, status: "undoing" }));
      return job;
    });
    this.scheduleUndo(userId, jobId);
    return serializeGmailScalableJob(claimed);
  }

  discard(userId: string, jobId: string) {
    const current = this.requireJob(userId, jobId);
    if (!["created", "safety_checking", "ready", "failed"].includes(current.view.status)) {
      throw new GmailScalableCleanupError("Scalable cleanup cannot be discarded after Trash work begins.", 409);
    }
    this.dependencies.store.delete(userId, jobId);
    return true;
  }

  private scheduleSafety(userId: string, jobId: string, delayMs = 0) {
    this.dependencies.schedule(() => this.runSafety(userId, jobId), delayMs);
  }

  private scheduleMutation(userId: string, jobId: string, delayMs = 0) {
    this.dependencies.schedule(() => this.runMutation(userId, jobId), delayMs);
  }

  private scheduleVerification(userId: string, jobId: string, delayMs = 0) {
    this.dependencies.schedule(() => this.runVerification(userId, jobId), delayMs);
  }

  private scheduleUndo(userId: string, jobId: string, delayMs = 0) {
    this.dependencies.schedule(() => this.runUndo(userId, jobId), delayMs);
  }

  private async runSafety(userId: string, jobId: string) {
    let current = this.requireJob(userId, jobId);
    if (current.view.status === "created" || current.view.status === "chunk_complete") {
      current = this.transition(current, "safety_checking", (job) => {
        const chunkIndex = nextChunkIndex(job, "pending");
        job.view.chunks[chunkIndex] = { ...job.view.chunks[chunkIndex], status: "safety_checking", startedAt: this.dependencies.now() };
        return job;
      });
    }
    if (current.view.status !== "safety_checking") return;
    const chunkIndex = nextChunkIndex(current, "safety_checking");
    try {
      await this.dependencies.validateContext(userId, current.payload.scanId, current.view.groupIndices);
      const provider = await this.dependencies.providerForUser(userId);
      const result = await provider.runSafetyCheck({
        uidValidity: current.payload.uidValidity,
        targets: current.payload.chunks[chunkIndex].targets,
        reserve: (kind) => this.reserveQuota(userId, jobId, chunkIndex, "safety_checking", kind)
      });
      current = this.requireJob(userId, jobId);
      const priorChunkComplete = current.view.chunks.some((candidate) => candidate.index < chunkIndex && candidate.status === "complete");
      const updated = this.dependencies.store.compareAndSet(userId, jobId, current.version, (job) => {
        const sensitiveChunk = job.payload.chunks[chunkIndex];
        const safeIds = new Set(result.safeTargets.map((target) => target.apiMessageId));
        sensitiveChunk.safeTargetIndexes = sensitiveChunk.targets.flatMap((target, index) =>
          safeIds.has(target.apiMessageId) ? [index] : []
        );
        const chunk = job.view.chunks[chunkIndex];
        const allExcluded = result.safeTargets.length === 0;
        const chunkStatus = allExcluded ? "complete" : priorChunkComplete ? "mutating" : "ready";
        job.view.chunks[chunkIndex] = {
          ...chunk,
          status: chunkStatus,
          safeCount: result.safeTargets.length,
          excludedCount: chunk.targetCount - result.safeTargets.length,
          retryCount: chunk.retryCount + result.retryCount,
          uidValidityValid: true,
          idMatchCount: chunk.targetCount - result.missingCount - result.identityMismatchCount,
          missingCount: result.missingCount,
          identityMismatchCount: result.identityMismatchCount,
          starredExcludedCount: result.starredCount,
          importantExcludedCount: result.importantCount,
          sentExcludedCount: result.sentCount,
          draftExcludedCount: result.draftCount,
          personalExcludedCount: result.personalCount,
          personalListRequests: result.personalListRequests,
          imapMs: result.imapMs,
          personalMs: result.personalMs,
          completedAt: allExcluded ? this.dependencies.now() : chunk.completedAt
        };
        job.view.undoAvailable = false;
        return setStatus(job, allExcluded ? "chunk_complete" : priorChunkComplete ? "mutating" : "ready", this.dependencies.now());
      });
      if (!updated) throw new Error("Scalable safety result could not be committed.");
      if (updated.view.status === "mutating") this.scheduleMutation(userId, jobId);
      if (updated.view.status === "chunk_complete") {
        const hasNext = updated.view.chunks.some((candidate) => candidate.status === "pending");
        if (hasNext) this.scheduleSafety(userId, jobId);
        else {
          this.transition(updated, "complete", (job) => {
            job.view.undoAvailable = hasExactVerifiedMovedLedger(job);
            return job;
          });
        }
      }
    } catch (error) {
      this.handleOperationError(userId, jobId, "safety_checking", error);
    }
  }

  private async runMutation(userId: string, jobId: string) {
    let current = this.requireJob(userId, jobId);
    if (current.view.status !== "mutating") return;
    const chunkIndex = nextChunkIndex(current, "mutating");
    const targets = selectIndexedTargets(
      current.payload.chunks[chunkIndex].targets,
      current.payload.chunks[chunkIndex].safeTargetIndexes
    );
    try {
      await this.dependencies.validateContext(userId, current.payload.scanId, current.view.groupIndices);
      const provider = await this.dependencies.providerForUser(userId);
      const mutationStarted = performance.now();
      if (!current.payload.chunks[chunkIndex].trashMutationDispatched) {
        const checkpoint = await provider.captureHistoryCheckpoint(
          (kind) => this.reserveQuota(userId, jobId, chunkIndex, "mutating", kind)
        );
        current = this.requireJob(userId, jobId);
        const dispatching = this.dependencies.store.compareAndSet(userId, jobId, current.version, (job) => {
          job.payload.chunks[chunkIndex].historyCheckpoint = checkpoint;
          job.payload.chunks[chunkIndex].trashMutationDispatched = true;
          const chunk = job.view.chunks[chunkIndex];
          job.view.chunks[chunkIndex] = {
            ...chunk,
            attemptedCount: targets.length,
            profileRequests: chunk.profileRequests + 1,
            batchModifyRequests: chunk.batchModifyRequests + 1
          };
          return job;
        });
        if (!dispatching) throw new Error("Scalable mutation dispatch intent could not be committed.");
        await provider.moveToTrash(
          targets.map((target) => target.apiMessageId),
          (kind) => this.reserveQuota(userId, jobId, chunkIndex, "mutating", kind)
        );
        this.dependencies.onMutationAttempted(userId);
      }
      current = this.requireJob(userId, jobId);
      const verifying = this.transition(current, "verifying", (job) => {
        const chunk = job.view.chunks[chunkIndex];
        job.view.chunks[chunkIndex] = {
          ...chunk,
          status: "verifying",
          attemptedCount: targets.length,
          mutationMs: chunk.mutationMs + Math.round(performance.now() - mutationStarted)
        };
        return job;
      });
      this.scheduleVerification(userId, verifying.view.id);
    } catch (error) {
      this.handleMutationError(userId, jobId, chunkIndex, targets.length, error);
    }
  }

  private async runVerification(userId: string, jobId: string) {
    const current = this.requireJob(userId, jobId);
    if (current.view.status !== "verifying") return;
    const chunkIndex = nextChunkIndex(current, "verifying");
    const sensitiveChunk = current.payload.chunks[chunkIndex];
    const safeTargets = selectIndexedTargets(sensitiveChunk.targets, sensitiveChunk.safeTargetIndexes);
    const targetIds = safeTargets.map((target) => target.apiMessageId);
    if (!sensitiveChunk.historyCheckpoint) {
      this.failJob(current, "The Trash verification checkpoint is unavailable.");
      return;
    }
    try {
      const provider = await this.dependencies.providerForUser(userId);
      const result = await provider.verifyTrash({
        targetIds,
        startHistoryId: sensitiveChunk.historyCheckpoint,
        reserve: (kind) => this.reserveQuota(userId, jobId, chunkIndex, "verifying", kind)
      });
      assertVerificationAccounting(targetIds.length, result);
      const postStateAudit = await this.collectPostStateAudit({
        provider,
        userId,
        jobId,
        targetCount: targetIds.length,
        authoritativeHistoryVerifiedCount: result.historyVerifiedCount,
        verifiedTargetIds: result.verifiedIds,
        phase: "cleanup"
      });
      const latest = this.requireJob(userId, jobId);
      const updated = this.dependencies.store.compareAndSet(userId, jobId, latest.version, (job) => {
        const verifiedIds = new Set(result.verifiedIds);
        job.payload.chunks[chunkIndex].verifiedMovedIndexes = job.payload.chunks[chunkIndex].targets.flatMap((target, index) =>
          verifiedIds.has(target.apiMessageId) ? [index] : []
        );
        const chunk = job.view.chunks[chunkIndex];
        const status = result.uncertainIds.length ? "uncertain" : result.failedIds.length ? "partial" : "complete";
        job.view.chunks[chunkIndex] = {
          ...chunk,
          status,
          verifiedCount: result.verifiedIds.length,
          failedCount: result.failedIds.length,
          uncertainCount: result.uncertainIds.length,
          historyVerifiedCount: result.historyVerifiedCount,
          listVerifiedCount: result.listVerifiedCount,
          getVerifiedCount: result.getVerifiedCount,
          getFallbackRequests: result.getFallbackRequests,
          retryCount: chunk.retryCount + result.retryCount,
          historyRequests: chunk.historyRequests + result.historyRequests,
          historyPages: chunk.historyPages + result.historyPages,
          fallbackListRequests: chunk.fallbackListRequests + result.listRequests,
          fallbackListPages: chunk.fallbackListPages + result.listPages,
          verificationMs: chunk.verificationMs + result.durationMs,
          completedAt: this.dependencies.now()
        };
        job.view.suggestedDeltas = addGroupDeltas(
          job.view.suggestedDeltas,
          countTargetsByGroup(safeTargets, verifiedIds),
          "moved"
        );
        const nextStatus: GmailScalableJobStatus = result.uncertainIds.length
          ? "uncertain"
          : result.failedIds.length
            ? "partial"
            : "chunk_complete";
        job.view.undoAvailable = false;
        if (postStateAudit) {
          job.view.postStateAudit = { ...job.view.postStateAudit, cleanup: postStateAudit };
        }
        return setStatus(job, nextStatus, this.dependencies.now());
      });
      if (!updated) throw new Error("Scalable verification result could not be committed.");
      if (updated.view.status === "chunk_complete") {
        const hasNext = updated.view.chunks.some((candidate) => candidate.status === "pending");
        if (hasNext) {
          this.scheduleSafety(userId, jobId);
        } else {
          this.transition(updated, "complete", (job) => {
            job.view.undoAvailable = hasExactVerifiedMovedLedger(job);
            return job;
          });
        }
      }
    } catch (error) {
      this.handleOperationError(userId, jobId, "verifying", error);
    }
  }

  private async runUndo(userId: string, jobId: string) {
    let current = this.requireJob(userId, jobId);
    if (current.view.status !== "undoing") return;
    const chunkIndex = current.payload.chunks.findIndex(
      (chunk) => chunk.verifiedMovedIndexes.length > 0 && chunk.verifiedRestoredIndexes.length === 0
    );
    if (chunkIndex < 0) return;
    const targetIds = selectIndexedTargets(
      current.payload.chunks[chunkIndex].targets,
      current.payload.chunks[chunkIndex].verifiedMovedIndexes
    ).map((target) => target.apiMessageId);
    try {
      const provider = await this.dependencies.providerForUser(userId);
      let checkpoint = current.payload.chunks[chunkIndex].undoHistoryCheckpoint;
      if (!current.payload.chunks[chunkIndex].undoMutationDispatched) {
        checkpoint = await provider.captureHistoryCheckpoint(
          (kind) => this.reserveQuota(userId, jobId, chunkIndex, "undoing", kind)
        );
        current = this.requireJob(userId, jobId);
        const dispatching = this.dependencies.store.compareAndSet(userId, jobId, current.version, (job) => {
          job.payload.chunks[chunkIndex].undoHistoryCheckpoint = checkpoint;
          job.payload.chunks[chunkIndex].undoMutationDispatched = true;
          const chunk = job.view.chunks[chunkIndex];
          job.view.chunks[chunkIndex] = {
            ...chunk,
            profileRequests: chunk.profileRequests + 1,
            undoMutationRequests: chunk.undoMutationRequests + 1
          };
          return job;
        });
        if (!dispatching) throw new Error("Scalable Undo dispatch intent could not be committed.");
        await provider.removeTrashLabel(
          targetIds,
          (kind) => this.reserveQuota(userId, jobId, chunkIndex, "undoing", kind)
        );
      }
      if (!checkpoint) throw new Error("Scalable Undo checkpoint is unavailable.");
      const result = await provider.verifyTrashRemoval({
        targetIds,
        startHistoryId: checkpoint,
        reserve: (kind) => this.reserveQuota(userId, jobId, chunkIndex, "undoing", kind)
      });
      assertVerificationAccounting(targetIds.length, result);
      const postStateAudit = await this.collectPostStateAudit({
        provider,
        userId,
        jobId,
        targetCount: result.verifiedIds.length,
        authoritativeHistoryVerifiedCount: result.historyVerifiedCount,
        verifiedTargetIds: result.verifiedIds,
        phase: "undo"
      });
      current = this.requireJob(userId, jobId);
      const updated = this.dependencies.store.compareAndSet(userId, jobId, current.version, (job) => {
        const restoredIds = new Set(result.verifiedIds);
        job.payload.chunks[chunkIndex].verifiedRestoredIndexes = job.payload.chunks[chunkIndex].targets.flatMap((target, index) =>
          restoredIds.has(target.apiMessageId) ? [index] : []
        );
        const chunk = job.view.chunks[chunkIndex];
        job.view.chunks[chunkIndex] = {
          ...chunk,
          status: result.uncertainIds.length ? "uncertain" : result.failedIds.length ? "partial" : "undo_complete",
          verifiedRestoredCount: result.verifiedIds.length,
          failedRestoreCount: result.failedIds.length,
          uncertainRestoreCount: result.uncertainIds.length,
          getFallbackRequests: chunk.getFallbackRequests + result.getFallbackRequests,
          retryCount: chunk.retryCount + result.retryCount,
          undoHistoryVerifiedCount: chunk.undoHistoryVerifiedCount + result.historyVerifiedCount,
          undoFallbackVerifiedCount: chunk.undoFallbackVerifiedCount + result.listVerifiedCount + result.getVerifiedCount,
          undoQuotaUnits: Math.max(
            0,
            job.view.quotaConsumedUnits - (job.payload.undoQuotaStartUnits ?? job.view.quotaConsumedUnits) -
              job.view.chunks.reduce((total, candidate, index) => total + (index === chunkIndex ? 0 : candidate.undoQuotaUnits), 0)
          ),
          completedAt: this.dependencies.now()
        };
        job.view.suggestedDeltas = addGroupDeltas(
          job.view.suggestedDeltas,
          countTargetsByGroup(job.payload.chunks[chunkIndex].targets, restoredIds),
          "restored"
        );
        if (postStateAudit) {
          job.view.postStateAudit = { ...job.view.postStateAudit, undo: postStateAudit };
        }
        const hasMore = job.payload.chunks.some(
          (candidate) => candidate.verifiedMovedIndexes.length > 0 && candidate.verifiedRestoredIndexes.length === 0
        );
        return setStatus(
          job,
          result.uncertainIds.length ? "uncertain" : result.failedIds.length ? "partial" : hasMore ? "undoing" : "undo_complete",
          this.dependencies.now()
        );
      });
      if (!updated) throw new Error("Scalable Undo result could not be committed.");
      if (updated.view.status === "undoing") this.scheduleUndo(userId, jobId);
    } catch (error) {
      this.handleMutationError(userId, jobId, chunkIndex, targetIds.length, error, true);
    }
  }

  private async reserveQuota(
    userId: string,
    jobId: string,
    chunkIndex: number,
    resumeState: NonNullable<GmailScalableSensitivePayload["resumeState"]>,
    kind: GmailScalableQuotaRequestKind
  ) {
    const units = gmailScaleQuotaUnits[kind];
    const current = this.requireJob(userId, jobId);
    const now = this.dependencies.now();
    const window = current.payload.quotaWindow;
    const activeWindow = now - window.startedAt >= quotaWindowMs
      ? { startedAt: now, consumedUnits: 0 }
      : window;
    if (activeWindow.consumedUnits + units > gmailScalePolicy.workingUnitsPerMinute) {
      const nextEligibleRunAt = activeWindow.startedAt + quotaWindowMs;
      const paused = this.dependencies.store.compareAndSet(userId, jobId, current.version, (job) => {
        assertGmailScalableTransition(job.view.status, "paused");
        job.payload.quotaWindow = activeWindow;
        job.payload.resumeState = resumeState;
        job.view.status = "paused";
        job.view.nextEligibleRunAt = nextEligibleRunAt;
        return refreshStoredJob(job);
      });
      if (paused) this.scheduleResume(userId, jobId, resumeState, Math.max(0, nextEligibleRunAt - now));
      throw new GmailScalableQuotaPauseError(nextEligibleRunAt);
    }
    const reserved = this.dependencies.store.compareAndSet(userId, jobId, current.version, (job) => {
      job.payload.quotaWindow = { ...activeWindow, consumedUnits: activeWindow.consumedUnits + units };
      job.view.quotaConsumedUnits += units;
      job.view.chunks[chunkIndex] = {
        ...job.view.chunks[chunkIndex],
        quotaUnits: job.view.chunks[chunkIndex].quotaUnits + units
      };
      return refreshStoredJob(job);
    });
    if (!reserved) throw new Error("Gmail quota reservation conflicted with another runner operation.");
  }

  private async collectPostStateAudit(input: {
    provider: GmailScalableCleanupProviderPort;
    userId: string;
    jobId: string;
    targetCount: number;
    authoritativeHistoryVerifiedCount: number;
    verifiedTargetIds: readonly string[];
    phase: "cleanup" | "undo";
  }): Promise<GmailScalablePostStateAuditPhase | undefined> {
    if (!this.dependencies.postStateAuditEnabled) return undefined;
    try {
      const result = await input.provider.auditTrashPostState({
        targetIds: input.verifiedTargetIds,
        reserve: (kind) => this.reserveAuditQuota(input.userId, input.jobId, kind)
      });
      return {
        state: "complete",
        targetCount: input.targetCount,
        authoritativeHistoryVerifiedCount: input.authoritativeHistoryVerifiedCount,
        exactTargetMessagesFoundInTrash: result.exactTargetMessagesFoundInTrash,
        exactTargetMessagesAbsentFromTrash: result.exactTargetMessagesAbsentFromTrash,
        distinctGmailThreadCount: result.distinctGmailThreadCount,
        trashListRequests: result.trashListRequests,
        trashListPages: result.trashListPages,
        mismatchCount: input.phase === "cleanup"
          ? result.exactTargetMessagesAbsentFromTrash
          : result.exactTargetMessagesFoundInTrash
      };
    } catch {
      return {
        state: "failed",
        targetCount: input.targetCount,
        authoritativeHistoryVerifiedCount: input.authoritativeHistoryVerifiedCount,
        exactTargetMessagesFoundInTrash: 0,
        exactTargetMessagesAbsentFromTrash: 0,
        distinctGmailThreadCount: 0,
        trashListRequests: 0,
        trashListPages: 0,
        mismatchCount: 0,
        error: "Development post-state audit unavailable."
      };
    }
  }

  private async reserveAuditQuota(userId: string, jobId: string, kind: GmailScalableQuotaRequestKind) {
    if (kind !== "messagesList") throw new Error("Development post-state audit may use only Gmail messages.list.");
    const units = gmailScaleQuotaUnits[kind];
    const current = this.requireJob(userId, jobId);
    const now = this.dependencies.now();
    const window = current.payload.quotaWindow;
    const activeWindow = now - window.startedAt >= quotaWindowMs
      ? { startedAt: now, consumedUnits: 0 }
      : window;
    if (activeWindow.consumedUnits + units > gmailScalePolicy.workingUnitsPerMinute) {
      throw new Error("Development post-state audit skipped because the Gmail working quota budget is unavailable.");
    }
    const reserved = this.dependencies.store.compareAndSet(userId, jobId, current.version, (job) => {
      job.payload.quotaWindow = { ...activeWindow, consumedUnits: activeWindow.consumedUnits + units };
      job.view.developmentAuditQuotaUnits += units;
      return refreshStoredJob(job);
    });
    if (!reserved) throw new Error("Development post-state audit quota reservation conflicted.");
  }

  private scheduleResume(
    userId: string,
    jobId: string,
    resumeState: NonNullable<GmailScalableSensitivePayload["resumeState"]>,
    delayMs: number
  ) {
    this.dependencies.schedule(async () => {
      const current = this.dependencies.store.get(userId, jobId);
      if (!current || current.view.status !== "paused" || current.payload.resumeState !== resumeState) return;
      const resumed = this.transition(current, resumeState, (job) => {
        job.view.nextEligibleRunAt = undefined;
        job.payload.resumeState = undefined;
        return job;
      });
      if (resumeState === "safety_checking") this.scheduleSafety(userId, resumed.view.id);
      if (resumeState === "mutating") this.scheduleMutation(userId, resumed.view.id);
      if (resumeState === "verifying") this.scheduleVerification(userId, resumed.view.id);
      if (resumeState === "undoing") this.scheduleUndo(userId, resumed.view.id);
    }, delayMs);
  }

  private handleOperationError(
    userId: string,
    jobId: string,
    resumeState: NonNullable<GmailScalableSensitivePayload["resumeState"]>,
    error: unknown
  ) {
    if (error instanceof GmailScalableQuotaPauseError) return;
    const current = this.dependencies.store.get(userId, jobId);
    if (!current || current.view.status !== resumeState) return;
    this.failJob(current, safeRunnerError(error));
  }

  private handleMutationError(
    userId: string,
    jobId: string,
    chunkIndex: number,
    attemptedCount: number,
    error: unknown,
    undo = false
  ) {
    if (error instanceof GmailScalableQuotaPauseError) return;
    const current = this.dependencies.store.get(userId, jobId);
    if (!current) return;
    const updated = this.dependencies.store.compareAndSet(userId, jobId, current.version, (job) => {
      const chunk = job.view.chunks[chunkIndex];
      job.view.chunks[chunkIndex] = undo
        ? { ...chunk, status: "uncertain", uncertainRestoreCount: attemptedCount }
        : { ...chunk, status: "uncertain", attemptedCount, uncertainCount: attemptedCount };
      return setStatus(job, "uncertain", this.dependencies.now(), safeRunnerError(error));
    });
    if (!updated) return;
  }

  private failJob(current: GmailScalableStoredJob, message: string) {
    return this.dependencies.store.compareAndSet(current.userId, current.view.id, current.version, (job) =>
      setStatus(job, "failed", this.dependencies.now(), message)
    );
  }

  private transition(
    current: GmailScalableStoredJob,
    status: GmailScalableJobStatus,
    update: (job: GmailScalableStoredJob) => GmailScalableStoredJob
  ) {
    assertGmailScalableTransition(current.view.status, status);
    const changed = this.dependencies.store.compareAndSet(current.userId, current.view.id, current.version, (job) => {
      job.view.status = status;
      return refreshStoredJob(update(job));
    });
    if (!changed) throw new GmailScalableCleanupError("Scalable cleanup state changed. Read the current status and try again.", 409);
    return changed;
  }

  private incrementDuplicate(current: GmailScalableStoredJob, field: "duplicateDispatchCount" | "duplicateUndoCount") {
    return this.dependencies.store.compareAndSet(current.userId, current.view.id, current.version, (job) => {
      job.view[field] += 1;
      return refreshStoredJob(job);
    }) ?? current;
  }

  private requireJob(userId: string, jobId: string) {
    const job = this.dependencies.store.get(userId, jobId);
    if (!job) throw new GmailScalableCleanupError("Scalable cleanup job expired.", 410);
    return job;
  }
}

const globalRunner = globalThis as unknown as { organizinboxScalableCleanupRunner?: CleanupJobRunner };

export const gmailScalableCleanupRunner = globalRunner.organizinboxScalableCleanupRunner ?? new CleanupJobRunner({
  store: gmailScalableCleanupStore,
  async providerForUser(userId) {
    const connection = await getActiveGmailConnection(userId);
    if (!connection) throw new GmailScalableCleanupError("An active Gmail connection is required.", 401);
    return new GmailScalableCleanupProvider(connection.accessToken, connection.accountEmail);
  },
  validateContext(userId, scanId, groupIndices) {
    const scan = getLiveScan(userId);
    if (!scan?.report || scan.progress.scanId !== scanId || scan.progress.status !== "completed" || scan.reportStale) {
      throw new GmailScalableCleanupError("The Inbox Report changed or expired. Run a fresh scan.", 409);
    }
    const groups = buildCleanupSenderGroups(scan.report.senders);
    if (groupIndices.some((index) => !groups[index]?.eligible)) {
      throw new GmailScalableCleanupError("A selected sender group is no longer eligible.", 409);
    }
  },
  onMutationAttempted: markLiveReportStale,
  now: Date.now,
  schedule(work, delayMs) {
    const timer = setTimeout(() => void work().catch(() => undefined), delayMs);
    timer.unref?.();
  },
  acceptanceHash: sha256Base64Url,
  postStateAuditEnabled: isGmailScalablePostStateAuditEnabled({
    auditEnabled: runtimeConfig.gmailScalablePostStateAuditEnabled,
    scalableCleanupEnabled: runtimeConfig.gmailScalableCleanupDevEnabled,
    nodeEnv: process.env.NODE_ENV
  })
});
globalRunner.organizinboxScalableCleanupRunner = gmailScalableCleanupRunner;

export async function startGmailScalableCleanup(input: { groupIndices: unknown; requestedCount: unknown }) {
  const session = await requireScalableSession();
  const { userId } = session;
  const scan = getLiveScan(userId);
  if (!scan?.report || scan.progress.status !== "completed" || scan.progress.provider !== "gmail" || scan.reportStale) {
    throw new GmailScalableCleanupError("Run a fresh Gmail scan before scalable cleanup.", 409);
  }
  if (!scan.gmailUidValidity || !scan.scalableCleanupTargets) {
    throw new GmailScalableCleanupError("The fresh scan did not retain the exact Gmail identity bridge required for scalable cleanup.", 409);
  }
  const requestedCount = parseScalableCount(input.requestedCount);
  const groupIndices = parseGroupIndices(input.groupIndices);
  const { acceptDurableGmailScalableCleanup } = await import("@/lib/server/gmail-scalable-live-workflow");
  return acceptDurableGmailScalableCleanup({
    userId,
    providerConnectionId: session.providerConnectionId,
    scanId: scan.progress.scanId,
    uidValidity: scan.gmailUidValidity,
    requestedCount: requestedCount as 250 | 500,
    groupIndices,
    groups: buildCleanupSenderGroups(scan.report.senders),
    targets: scan.scalableCleanupTargets
  });
}

export async function getGmailScalableCleanupStatus(jobId: string) {
  const { userId } = await requireScalableSession();
  const { getDurableGmailScalableCleanupStatus } = await import("@/lib/server/gmail-scalable-live-workflow");
  return getDurableGmailScalableCleanupStatus(userId, jobId);
}

export async function getCurrentGmailScalableCleanup() {
  if (process.env.NODE_ENV === "production" || !runtimeConfig.gmailScalableCleanupDevEnabled) return undefined;
  const session = await getSession();
  if (!session?.userId || !durableWorkflowEnabled()) return undefined;
  const { getLatestDurableGmailScalableCleanup } = await import("@/lib/server/gmail-scalable-live-workflow");
  return getLatestDurableGmailScalableCleanup(session.userId);
}

export async function confirmGmailScalableCleanup(jobId: string) {
  const { userId } = await requireScalableSession();
  const { confirmDurableGmailScalableCleanup } = await import("@/lib/server/gmail-scalable-live-workflow");
  return confirmDurableGmailScalableCleanup(userId, jobId);
}

export async function undoGmailScalableCleanup(jobId: string) {
  const { userId } = await requireScalableSession();
  const { undoDurableGmailScalableCleanup } = await import("@/lib/server/gmail-scalable-live-workflow");
  return undoDurableGmailScalableCleanup(userId, jobId);
}

export async function discardGmailScalableCleanup(jobId: string) {
  const { userId } = await requireScalableSession();
  const { discardDurableGmailScalableCleanup } = await import("@/lib/server/gmail-scalable-live-workflow");
  return discardDurableGmailScalableCleanup(userId, jobId);
}

export function parseScalableCount(value: unknown) {
  const count = Number(value);
  assertDevelopmentGate(count);
  return count;
}

async function requireScalableSession() {
  try {
    assertGmailScalableDevelopmentGate({
      enabled: runtimeConfig.gmailScalableCleanupDevEnabled,
      nodeEnv: process.env.NODE_ENV,
      requestedCount: gmailScalableCleanupDevMaximum
    });
  } catch {
    throw new GmailScalableCleanupError("Scalable Gmail cleanup is disabled.", 403);
  }
  if (runtimeConfig.fixtureMode) throw new GmailScalableCleanupError("Fixture mode cannot perform scalable Gmail cleanup.", 403);
  if (!durableWorkflowEnabled()) throw new GmailScalableCleanupError("Durable scalable Gmail cleanup is disabled.", 403);
  const session = await getSession();
  if (!session?.userId) throw new GmailScalableCleanupError("Connect Gmail before scalable cleanup.", 401);
  return session;
}

function durableWorkflowEnabled() {
  return runtimeConfig.gmailScalableWorkflowEnabled && runtimeConfig.gmailScalableStoreAdapter === "prisma";
}

function assertDevelopmentGate(count: number) {
  if (getGmailCleanupRequestMode({
    requestedCount: count,
    legacyMaximum: runtimeConfig.gmailCleanupMaxMessages,
    scalableEnabled: true
  }) !== "scalable") {
    throw new GmailScalableCleanupError("Controlled scalable cleanup requires exactly 250 or 500 messages.", 400);
  }
}

function parseGroupIndices(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new GmailScalableCleanupError("Select at least one sender group.", 400);
  const indices = value.map(Number);
  if (indices.some((index) => !Number.isInteger(index) || index < 0) || new Set(indices).size !== indices.length) {
    throw new GmailScalableCleanupError("The sender-group selection is invalid.", 400);
  }
  return indices;
}

function nextChunkIndex(job: GmailScalableStoredJob, status: GmailScalableStoredJob["view"]["chunks"][number]["status"]) {
  const index = job.view.chunks.findIndex((chunk) => chunk.status === status);
  if (index < 0) throw new Error(`No scalable cleanup chunk is ${status}.`);
  return index;
}

function setStatus(job: GmailScalableStoredJob, status: GmailScalableJobStatus, now: number, error?: string) {
  if (job.view.status !== status) assertGmailScalableTransition(job.view.status, status);
  job.view.status = status;
  job.view.error = error;
  if (["complete", "partial", "uncertain", "failed", "undo_complete"].includes(status)) job.view.completedAt = now;
  return refreshStoredJob(job);
}

function refreshStoredJob(job: GmailScalableStoredJob) {
  job.view = refreshView(job.view);
  return job;
}

function refreshView(view: GmailScalableJobView): GmailScalableJobView {
  const { quotaUnits: _quotaUnits, ...summary } = summarizeGmailScalableChunks(view.chunks);
  void _quotaUnits;
  const next = {
    ...view,
    ...summary,
    updatedAt: Date.now()
  };
  return { ...next, progressLabel: gmailScalableProgressLabel(next.status, next) };
}

function assertVerificationAccounting(
  attempted: number,
  result: { verifiedIds: readonly string[]; failedIds: readonly string[]; uncertainIds: readonly string[] }
) {
  const all = [...result.verifiedIds, ...result.failedIds, ...result.uncertainIds];
  if (all.length !== attempted || new Set(all).size !== attempted) {
    throw new Error("Invalid scalable verification accounting.");
  }
}

function countTargetsByGroup(targets: readonly GmailScalableCleanupTarget[], ids: ReadonlySet<string>) {
  const counts = new Map<number, number>();
  for (const target of targets) {
    if (ids.has(target.apiMessageId)) counts.set(target.groupIndex, (counts.get(target.groupIndex) ?? 0) + 1);
  }
  return counts;
}

function selectIndexedTargets(targets: readonly GmailScalableCleanupTarget[], indexes: readonly number[]) {
  if (new Set(indexes).size !== indexes.length) throw new Error("Scalable cleanup target ledger contains duplicate indexes.");
  return indexes.map((index) => {
    const target = targets[index];
    if (!target) throw new Error("Scalable cleanup target ledger is invalid.");
    return target;
  });
}

function hasExactVerifiedMovedLedger(job: GmailScalableStoredJob) {
  if (
    job.view.attemptedCount <= 0 ||
    job.view.requestedCount !== job.view.excludedCount + job.view.attemptedCount ||
    job.view.verifiedCount !== job.view.attemptedCount ||
    job.view.failedCount !== 0 ||
    job.view.uncertainCount !== 0
  ) {
    return false;
  }
  return job.payload.chunks.every((sensitiveChunk) => {
    const chunk = job.view.chunks[sensitiveChunk.index];
    if (!chunk || chunk.attemptedCount !== chunk.verifiedCount || chunk.failedCount !== 0 || chunk.uncertainCount !== 0) {
      return false;
    }
    const safeIndexes = new Set(sensitiveChunk.safeTargetIndexes);
    const verifiedIndexes = new Set(sensitiveChunk.verifiedMovedIndexes);
    return safeIndexes.size === chunk.safeCount &&
      chunk.safeCount === chunk.attemptedCount &&
      verifiedIndexes.size === chunk.attemptedCount &&
      sensitiveChunk.verifiedMovedIndexes.length === verifiedIndexes.size &&
      [...verifiedIndexes].every((index) => safeIndexes.has(index));
  });
}

function addGroupDeltas(
  existing: readonly GmailScalableSuggestedDelta[],
  counts: ReadonlyMap<number, number>,
  direction: "moved" | "restored"
) {
  const merged = new Map(existing.map((delta) => [delta.groupIndex, { ...delta }]));
  for (const [groupIndex, count] of counts) {
    const current = merged.get(groupIndex) ?? { groupIndex, verifiedMovedCount: 0, verifiedRestoredCount: 0 };
    if (direction === "moved") current.verifiedMovedCount += count;
    else current.verifiedRestoredCount += count;
    merged.set(groupIndex, current);
  }
  return [...merged.values()].sort((left, right) => left.groupIndex - right.groupIndex);
}

function safeRunnerError(error: unknown) {
  if (error instanceof GmailScalableCleanupError) return error.message;
  return "Scalable cleanup stopped because Gmail state could not be verified safely.";
}
