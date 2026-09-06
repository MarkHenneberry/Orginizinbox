import "server-only";
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
  provider: "microsoft";
  userId: string;
  acceptanceKey: string;
  version: number;
  view: OutlookCleanupJobView;
  payload: {
    scanId: string;
    providerConnectionId: string;
    selectedSenders: Array<{ groupIndex: number; senderKey: string }>;
    participatedConversationIds: string[];
    targets: OutlookCleanupTarget[];
    cleanupSafetyContext?: MicrosoftCleanupSafetyContext;
    activeMoveBatchIndexes?: number[];
    activeUndoBatchIndexes?: number[];
    confirmedAt?: number;
  };
};

export type OutlookCleanupStore = DurableCleanupStore<OutlookCleanupStoredJob>;

export function createPrismaOutlookCleanupStore(): OutlookCleanupStore {
  return new PrismaCleanupJobStore<OutlookCleanupStoredJob>();
}

export function serializeOutlookCleanupJob(job: OutlookCleanupStoredJob | OutlookCleanupJobView) {
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
