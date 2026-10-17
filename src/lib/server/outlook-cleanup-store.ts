import "server-only";
import { blockedByPermanentDelete, type PermanentDeleteState } from "@/lib/domain/permanent-delete";
import {
  createEmptyOutlookCleanupHttpRoundTrips,
  createEmptyOutlookCleanupTiming,
  getOutlookCleanupBatchSize,
  getOutlookCleanupTotalBatches,
  outlookCleanupChunkSize,
  type OutlookCleanupJobView
} from "@/lib/domain/outlook-cleanup";
import {
  PrismaCleanupJobStore,
  type DurableCleanupStore
} from "@/lib/server/cleanup-job-store";
import type { MicrosoftCleanupSafetyContext } from "@/lib/providers/microsoft/provider";
import type { CleanupSenderGroup } from "@/lib/providers/gmail/cleanup-candidates";
import { prisma } from "@/lib/server/db";

export type OutlookCleanupTargetState =
  | "frozen"
  | "excluded"
  | "recheck_uncertain"
  | "move_dispatching"
  | "move_dispatched"
  | "move_failed"
  | "move_uncertain"
  | "moved_verified"
  | "restore_dispatching"
  | "restore_dispatched"
  | "restore_failed"
  | "restore_uncertain"
  | "restored_verified";

export type OutlookCleanupTarget = {
  originalMessageId: string;
  groupIndex: number;
  state: OutlookCleanupTargetState;
  originalFolderId?: string;
  movedMessageId?: string;
  restoredMessageId?: string;
};

export type OutlookCleanupStoredJob = {
  permanentDeletion?: PermanentDeleteState;
  provider: "microsoft";
  userId: string;
  acceptanceKey: string;
  version: number;
  view: OutlookCleanupJobView;
  payload: {
    senderGroups?: CleanupSenderGroup[];
    verificationCandidates?: Array<{ messageId: string; groupIndex: number }>;
    verificationCursor?: number;
    verificationContext?: MicrosoftCleanupSafetyContext;
    scanId: string;
    providerConnectionId: string;
    selectedSenders: Array<{ groupIndex: number; senderKey: string }>;
    participatedConversationIds: string[];
    targets: OutlookCleanupTarget[];
    cleanupSafetyContext?: MicrosoftCleanupSafetyContext;
    activeMoveBatchIndexes?: number[];
    activeUndoBatchIndexes?: number[];
    confirmedAt?: number;
    forwardCleanupStopped?: boolean;
  };
};

export type OutlookCleanupStore = DurableCleanupStore<OutlookCleanupStoredJob>;

export function createPrismaOutlookCleanupStore(): OutlookCleanupStore {
  return new PrismaCleanupJobStore<OutlookCleanupStoredJob>();
}

export function isOutlookPreMutationJob(job: OutlookCleanupStoredJob) {
  return ["created", "resolving", "ready"].includes(job.view.status) && !job.payload.confirmedAt &&
    !job.permanentDeletion && !job.payload.activeMoveBatchIndexes?.length && !job.payload.activeUndoBatchIndexes?.length &&
    job.view.movedVerified === 0 && job.view.restoredVerified === 0 && job.view.uncertain === 0 &&
    !job.view.undoAvailable && !job.view.recoverableCount &&
    job.payload.targets.every(target => target.state === "frozen" || target.state === "excluded");
}

export async function getOutlookCleanupForPresentation(userId: string, providerConnectionId: string, freshSelection = false) {
  const rows = await prisma.cleanupJobState.findMany({ where: {
    userId, expiresAt: { gt: new Date() },
    job: { status: { not: "cancelled" }, scan: { provider: "microsoft", providerConnectionId } }
  }, orderBy: { updatedAt: "desc" }, select: { jobId: true, job: { select: { scanId: true } } } });
  const store = createPrismaOutlookCleanupStore();
  let prepared: OutlookCleanupStoredJob | undefined;
  for (const row of rows) {
    const job = await store.get(userId, row.jobId);
    if (!job) continue;
    if (job.provider !== "microsoft" || job.payload.providerConnectionId !== providerConnectionId || job.payload.scanId !== row.job.scanId) {
      throw new Error("Cleanup ownership could not be verified.");
    }
    if (!isOutlookPreMutationJob(job)) return job;
    if (!freshSelection) prepared ??= job;
  }
  return prepared;
}

export function getOutlookCleanupLedgers(job: OutlookCleanupStoredJob) {
  return {
    verifiedMoved: job.payload.targets.filter((target, index) =>
      target.state === "moved_verified" && Boolean(target.movedMessageId) && Boolean(target.originalFolderId) &&
      !blockedByPermanentDelete(job.permanentDeletion, String(index))),
    failed: job.payload.targets.filter((target) => target.state === "move_failed" || target.state === "restore_failed"),
    uncertain: job.payload.targets.filter((target) => target.state.endsWith("_uncertain"))
  };
}

export function refreshOutlookRecovery(job: OutlookCleanupStoredJob) {
  const ledgers = getOutlookCleanupLedgers(job);
  job.view.uncertain = ledgers.uncertain.length + (job.permanentDeletion?.targets.filter(t => t.state === "uncertain" || t.state === "dispatching").length ?? 0);
  job.view.failed = ledgers.failed.length;
  job.view.movedVerified = job.payload.targets.filter((target) =>
    target.state === "moved_verified" || target.state.startsWith("restore")
  ).length;
  job.view.restoredVerified = job.payload.targets.filter((target) => target.state === "restored_verified").length;
  job.view.recoverableCount = ledgers.verifiedMoved.length;
  if (job.view.uncertain > 0 || job.view.status === "partial" || job.view.status === "failed") job.view.undoMode = "recovery";
  job.view.undoAvailable = ledgers.verifiedMoved.length > 0 &&
    ["complete", "partial", "uncertain", "failed"].includes(job.view.status) && job.view.expiresAt > Date.now();
}

export function serializeOutlookCleanupJob(job: OutlookCleanupStoredJob | OutlookCleanupJobView, includeSenderContext = true) {
  const view = "view" in job ? job.view : job;
  const adaptiveBatchSize = getOutlookCleanupBatchSize(view.requested);
  const legacyTotalBatches = Math.ceil(view.requested / 5);
  const effectiveBatchSize = view.effectiveBatchSize ?? (
    view.totalBatches === legacyTotalBatches && legacyTotalBatches !== Math.ceil(view.requested / adaptiveBatchSize)
      ? 5
      : adaptiveBatchSize
  );
  return structuredClone({
    ...view,
    ...("payload" in job ? {
      canChangeSelection: isOutlookPreMutationJob(job),
      senderGroups: includeSenderContext ? job.payload.senderGroups : undefined,
      recoverableCount: getOutlookCleanupLedgers(job).verifiedMoved.length,
      undoAvailable: ["complete", "partial", "uncertain", "failed"].includes(view.status) &&
        view.expiresAt > Date.now() && getOutlookCleanupLedgers(job).verifiedMoved.length > 0,
      undoMode: view.undoMode ?? (view.uncertain > 0 || view.status === "partial" || view.status === "failed" ? "recovery" : "full")
    } : {}),
    checked: view.checked ?? view.approved + view.excludedBySafety,
    chunksCompleted: view.chunksCompleted ?? 0,
    totalChunks: view.totalChunks ?? Math.ceil(view.requested / outlookCleanupChunkSize),
    batchesCompleted: view.batchesCompleted ?? 0,
    effectiveBatchSize,
    totalBatches: view.totalBatches ?? getOutlookCleanupTotalBatches(view.requested),
    currentChunk: view.currentChunk ?? 0,
    currentBatch: view.currentBatch ?? 0,
    undoBatchesCompleted: view.undoBatchesCompleted ?? 0,
    undoTotalBatches: view.undoTotalBatches ?? 0,
    httpRoundTrips: view.httpRoundTrips ?? view.graphRequests ?? 0,
    graphSubrequests: view.graphSubrequests ?? view.graphRequests ?? 0,
    httpRoundTripsByPhase: view.httpRoundTripsByPhase ?? createEmptyOutlookCleanupHttpRoundTrips(),
    timingMs: view.timingMs ?? createEmptyOutlookCleanupTiming()
  });
}
