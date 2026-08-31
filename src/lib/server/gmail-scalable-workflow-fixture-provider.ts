import "server-only";
import { runtimeConfig } from "@/lib/config";
import {
  GmailScalableQuotaPauseError,
  type GmailScalableCleanupProviderPort,
  type GmailScalableQuotaReservation,
  type GmailScalableVerificationResult
} from "@/lib/providers/gmail/scalable-cleanup-provider";
import type { GmailScalableCleanupTarget } from "@/lib/providers/gmail/scalable-targets";
import type { GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";

export class GmailScalableFixtureMutationInterruptedError extends Error {
  constructor() {
    super("Fixture mutation result intentionally became unknown.");
    this.name = "GmailScalableFixtureMutationInterruptedError";
  }
}

export class GmailScalableWorkflowFixtureProvider implements GmailScalableCleanupProviderPort {
  constructor(
    private readonly job: GmailScalableStoredJob,
    private readonly now: () => number = Date.now
  ) {
    assertFixtureProviderEnabled(job);
  }

  async runSafetyCheck(input: {
    uidValidity: string;
    targets: readonly GmailScalableCleanupTarget[];
    reserve: GmailScalableQuotaReservation;
  }) {
    const chunkIndex = this.chunkIndexForTargets(input.targets.map((target) => target.apiMessageId));
    const preflight = !this.job.payload.confirmedAt;
    if (!preflight) this.maybePause("cleanup", chunkIndex);
    await input.reserve("messagesList");
    this.record(preflight ? "preflight_safety" : "safety", chunkIndex);
    const excludedCount = (preflight
      ? this.control().preflightSafetyExcludedCountsByChunk
      : this.control().safetyExcludedCountsByChunk)[chunkIndex] ?? 0;
    if (!Number.isInteger(excludedCount) || excludedCount < 0 || excludedCount > input.targets.length) {
      throw new Error("Fixture safety exclusion count is invalid.");
    }
    return {
      safeTargets: input.targets.slice(0, input.targets.length - excludedCount),
      missingCount: 0,
      identityMismatchCount: 0,
      starredCount: 0,
      importantCount: 0,
      trashCount: 0,
      sentCount: 0,
      draftCount: 0,
      personalCount: excludedCount,
      personalListRequests: 1,
      retryCount: 0,
      imapMs: 1,
      personalMs: 1
    };
  }

  async captureHistoryCheckpoint(reserve: GmailScalableQuotaReservation) {
    const undo = this.job.view.status === "undoing" || (
      this.job.view.status === "paused" && this.job.payload.resumeState === "undoing"
    );
    const chunkIndex = undo ? this.activeUndoChunkIndex() : this.activeCleanupChunkIndex();
    if (undo) this.maybePause("undo", chunkIndex);
    await reserve("getProfile");
    this.record(undo ? "checkpoint_undo" : "checkpoint_trash", chunkIndex);
    return `fixture-checkpoint-${this.job.view.id}-${undo ? "undo" : "trash"}-${chunkIndex}`;
  }

  async moveToTrash(targetIds: readonly string[], reserve: GmailScalableQuotaReservation) {
    const chunkIndex = this.chunkIndexForTargets(targetIds);
    await reserve("batchModify");
    this.record("dispatch_trash", chunkIndex);
    if (this.control().interruptAfterTrashDispatchChunkIndexes.includes(chunkIndex)) {
      throw new GmailScalableFixtureMutationInterruptedError();
    }
  }

  async verifyTrash(input: { targetIds: readonly string[]; reserve: GmailScalableQuotaReservation }) {
    const chunkIndex = this.chunkIndexForTargets(input.targetIds);
    await input.reserve("historyList");
    this.record("verify_trash", chunkIndex);
    return fixtureVerification(
      input.targetIds,
      this.control().mutationOutcomesByChunk[chunkIndex] ?? this.control().mutationOutcome
    );
  }

  async removeTrashLabel(targetIds: readonly string[], reserve: GmailScalableQuotaReservation) {
    const chunkIndex = this.chunkIndexForTargets(targetIds);
    await reserve("batchModify");
    this.record("dispatch_undo", chunkIndex);
  }

  async verifyTrashRemoval(input: { targetIds: readonly string[]; reserve: GmailScalableQuotaReservation }) {
    const chunkIndex = this.chunkIndexForTargets(input.targetIds);
    await input.reserve("historyList");
    this.record("verify_undo", chunkIndex);
    return fixtureVerification(input.targetIds, "applied");
  }

  async auditTrashPostState(): Promise<never> {
    throw new Error("The development post-state audit is not available in Workflow fixtures.");
  }

  private maybePause(mode: "cleanup" | "undo", chunkIndex: number) {
    const control = this.control();
    const configured = mode === "cleanup"
      ? control.quotaPauseBeforeCleanupChunkIndexes
      : control.quotaPauseBeforeUndoChunkIndexes;
    const consumed = mode === "cleanup"
      ? control.consumedCleanupQuotaPauses
      : control.consumedUndoQuotaPauses;
    if (!configured.includes(chunkIndex) || consumed.includes(chunkIndex)) return;
    consumed.push(chunkIndex);
    throw new GmailScalableQuotaPauseError(this.now() + 60_000);
  }

  private record(operation: GmailScalableFixtureControlOperation, chunkIndex: number) {
    this.control().operationLedger.push({ operation, chunkIndex });
  }

  private activeCleanupChunkIndex() {
    const index = this.job.payload.chunks.findIndex((chunk) =>
      ["mutating", "verifying"].includes(this.job.view.chunks[chunk.index]?.status)
    );
    if (index < 0) throw new Error("Fixture cleanup chunk is unavailable.");
    return index;
  }

  private activeUndoChunkIndex() {
    const index = this.job.payload.chunks.findIndex(
      (chunk) => chunk.verifiedMovedIndexes.length > 0 && chunk.verifiedRestoredIndexes.length === 0
    );
    if (index < 0) throw new Error("Fixture Undo chunk is unavailable.");
    return index;
  }

  private chunkIndexForTargets(targetIds: readonly string[]) {
    const targetSet = new Set(targetIds);
    const index = this.job.payload.chunks.findIndex((chunk) =>
      targetIds.length > 0 && chunk.targets.some((target) => targetSet.has(target.apiMessageId))
    );
    if (index < 0) throw new Error("Fixture target ledger does not match the cleanup job.");
    return index;
  }

  private control() {
    const control = this.job.payload.fixture;
    if (!control?.enabled) throw new Error("Fixture control is unavailable.");
    return control;
  }
}

type GmailScalableFixtureControlOperation = GmailScalableStoredJob["payload"]["fixture"] extends infer T
  ? T extends { operationLedger: Array<infer Entry> }
    ? Entry extends { operation: infer Operation }
      ? Operation
      : never
    : never
  : never;

function assertFixtureProviderEnabled(job: GmailScalableStoredJob) {
  if (
    process.env.NODE_ENV === "production" ||
    !runtimeConfig.fixtureMode ||
    !runtimeConfig.gmailScalableWorkflowFixtureEnabled ||
    !job.payload.fixture?.enabled
  ) {
    throw new Error("The scalable Workflow fixture provider is disabled.");
  }
}

function fixtureVerification(
  targetIds: readonly string[],
  outcome: "applied" | "not_applied" | "uncertain"
): GmailScalableVerificationResult {
  const verifiedIds = outcome === "applied" ? [...targetIds] : [];
  const failedIds = outcome === "not_applied" ? [...targetIds] : [];
  const uncertainIds = outcome === "uncertain" ? [...targetIds] : [];
  return {
    verifiedIds,
    failedIds,
    uncertainIds,
    historyVerifiedCount: verifiedIds.length,
    listVerifiedCount: 0,
    getVerifiedCount: 0,
    historyRequests: 1,
    historyPages: 1,
    historyPollAttempts: 1,
    listRequests: 0,
    listPages: 0,
    getFallbackRequests: 0,
    retryCount: 0,
    historyUnavailable: false,
    durationMs: 1
  };
}
