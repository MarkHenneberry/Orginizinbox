import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { runtimeConfig } from "@/lib/config";
import {
  assertOutlookCleanupDevelopmentRequest,
  createEmptyOutlookCleanupHttpRoundTrips,
  createEmptyOutlookCleanupTiming,
  getOutlookCleanupBatchSize,
  getOutlookCleanupTotalBatches,
  isOutlookCleanupDevelopmentEnabled,
  outlookCleanupChunkSize
} from "@/lib/domain/outlook-cleanup";
import { assessMessage } from "@/lib/domain/recommendations";
import { MicrosoftProvider } from "@/lib/providers/microsoft/provider";
import { buildCleanupSenderGroups } from "@/lib/providers/gmail/cleanup-candidates";
import { sha256Base64Url } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import { cleanupStateExpiryFor, prepareCleanupJobState } from "@/lib/server/cleanup-job-store";
import { getLiveScan, markLiveReportStale } from "@/lib/server/live-scan-store";
import {
  forceRefreshMicrosoftConnection,
  getActiveMicrosoftConnection
} from "@/lib/server/microsoft-connection";
import {
  createPrismaOutlookCleanupStore,
  serializeOutlookCleanupJob,
  type OutlookCleanupStoredJob,
  type OutlookCleanupTarget
} from "@/lib/server/outlook-cleanup-store";
import { getSession } from "@/lib/server/session";
import { startProviderCleanupWorkflow } from "@/lib/server/provider-cleanup-workflow-start";
import { createProviderRequestCoordinator } from "@/lib/server/provider-request-coordinator";

export class OutlookCleanupError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "OutlookCleanupError";
  }
}

export type OutlookCleanupProviderPort = Pick<
  MicrosoftProvider,
  | "scanMetadata"
  | "scanParticipatedConversationIds"
  | "getCleanupSafetyContext"
  | "getDeletedItemsFolderId"
  | "getCleanupMessages"
  | "moveCleanupMessages"
  | "verifyCleanupMessageLocations"
> & { getScanMetrics?: () => { requests: number } };

export { getOutlookCleanupBatchSize } from "@/lib/domain/outlook-cleanup";

export async function startOutlookCleanup(input: { groupIndices: unknown; requestedCount: unknown }) {
  const requested = assertGate(input.requestedCount);
  const session = await requireSession();
  const liveScan = await getLiveScan(session.userId, "microsoft");
  if (
    !liveScan?.report ||
    liveScan.progress.status !== "completed" ||
    liveScan.progress.provider !== "microsoft" ||
    liveScan.reportStale ||
    !liveScan.participatedConversationIds
  ) throw new OutlookCleanupError("Run a fresh Outlook scan before cleanup.", 409);

  const groups = buildCleanupSenderGroups(liveScan.report.senders);
  const groupIndices = parseGroupIndices(input.groupIndices, groups.length);
  const selectedGroups = groupIndices.map((index) => groups[index]);
  if (selectedGroups.some((group) => !group?.eligible)) {
    throw new OutlookCleanupError("Every selected sender group must still be Suggested.", 409);
  }
  const selectedReadyCount = selectedGroups.reduce((total, group) => total + group.cleanupCandidateCount, 0);
  if (requested > selectedReadyCount) {
    throw new OutlookCleanupError("The selected groups do not contain that many Suggested messages.", 409);
  }

  const connection = await getActiveMicrosoftConnection(session.userId, session.providerConnectionId);
  if (!connection) throw new OutlookCleanupError("Reconnect Microsoft before cleanup.", 401);
  const acceptanceKey = sha256Base64Url(JSON.stringify([
    liveScan.progress.scanId,
    [...groupIndices].sort((left, right) => left - right),
    requested,
    "microsoft"
  ]));
  const now = Date.now();
  const jobId = randomUUID();
  const job: OutlookCleanupStoredJob = {
    provider: "microsoft",
    userId: session.userId,
    acceptanceKey,
    version: 0,
    view: {
      provider: "microsoft",
      id: jobId,
      status: "created",
      requested,
      approved: 0,
      excludedBySafety: 0,
      movedVerified: 0,
      restoredVerified: 0,
      failed: 0,
      uncertain: 0,
      checked: 0,
      chunksCompleted: 0,
      totalChunks: Math.ceil(requested / outlookCleanupChunkSize),
      batchesCompleted: 0,
      totalBatches: getOutlookCleanupTotalBatches(requested),
      currentChunk: 0,
      currentBatch: 0,
      effectiveBatchSize: getOutlookCleanupBatchSize(requested),
      undoBatchesCompleted: 0,
      undoTotalBatches: 0,
      graphRequests: 0,
      httpRoundTrips: 0,
      graphSubrequests: 0,
      retries: 0,
      httpRoundTripsByPhase: createEmptyOutlookCleanupHttpRoundTrips(),
      timingMs: createEmptyOutlookCleanupTiming(),
      groupIndices,
      undoAvailable: false,
      undoStatus: "not_available",
      createdAt: now,
      updatedAt: now,
      expiresAt: cleanupStateExpiryFor({ now, undoAvailable: false, terminal: false })
    },
    payload: {
      scanId: liveScan.progress.scanId,
      providerConnectionId: connection.connection.id,
      selectedSenders: selectedGroups.map((group) => ({
        groupIndex: group.index,
        senderKey: liveScan.report!.senders[group.index].senderKey
      })),
      participatedConversationIds: [...liveScan.participatedConversationIds],
      targets: []
    }
  };

  const store = createPrismaOutlookCleanupStore();
  const prepared = prepareCleanupJobState(job);
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.scan.upsert({
        where: { id: liveScan.progress.scanId },
        update: { status: "completed", completedAt: new Date(now) },
        create: {
          id: liveScan.progress.scanId,
          userId: session.userId,
          providerConnectionId: connection.connection.id,
          provider: "microsoft",
          status: "completed",
          startedAt: new Date(now),
          completedAt: new Date(now)
        }
      });
      await transaction.cleanupJob.create({
        data: { id: jobId, scanId: liveScan.progress.scanId, acceptanceKey, status: "pending" }
      });
      await transaction.cleanupJobState.create({ data: prepared.data });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const existingRow = await prisma.cleanupJob.findUnique({
      where: { scanId_acceptanceKey: { scanId: liveScan.progress.scanId, acceptanceKey } },
      select: { id: true, scan: { select: { userId: true, provider: true } } }
    });
    if (!existingRow || existingRow.scan.userId !== session.userId || existingRow.scan.provider !== "microsoft") throw error;
    const existing = await store.get(session.userId, existingRow.id);
    if (!existing || existing.provider !== "microsoft") {
      throw new OutlookCleanupError("The accepted cleanup job is not available yet. Try again.", 409);
    }
    await startProviderCleanupWorkflow(existing.view.id, "prepare");
    return serializeOutlookCleanupJob(existing);
  }
  await startProviderCleanupWorkflow(jobId, "prepare");
  return serializeOutlookCleanupJob(prepared.job);
}

export async function getOutlookCleanupStatus(jobId: string) {
  assertGate(1);
  const session = await requireSession();
  const job = await createPrismaOutlookCleanupStore().get(session.userId, jobId);
  if (!job || job.provider !== "microsoft") throw new OutlookCleanupError("Outlook cleanup job expired.", 410);
  return serializeOutlookCleanupJob(job);
}

export async function getCurrentOutlookCleanup() {
  if (!isOutlookCleanupEnabled()) return undefined;
  const session = await getSession();
  if (!session?.userId) return undefined;
  const row = await prisma.cleanupJobState.findFirst({
    where: {
      userId: session.userId,
      expiresAt: { gt: new Date() },
      job: { scan: { provider: "microsoft" } }
    },
    orderBy: { updatedAt: "desc" },
    select: { jobId: true }
  });
  const store = createPrismaOutlookCleanupStore();
  if (row) {
    const job = await store.get(session.userId, row.jobId);
    if (job?.provider === "microsoft") return serializeOutlookCleanupJob(job);
  }
  return undefined;
}

export async function confirmOutlookCleanup(jobId: string) {
  assertGate(1);
  const session = await requireSession();
  const store = createPrismaOutlookCleanupStore();
  const current = await store.get(session.userId, jobId);
  if (!current || current.provider !== "microsoft") throw new OutlookCleanupError("Outlook cleanup job expired.", 410);
  normalizeOutlookCleanupMetrics(current);
  if (current.view.status !== "ready") {
    if (current.view.status === "running") {
      await startProviderCleanupWorkflow(jobId, "cleanup");
      return serializeOutlookCleanupJob(current);
    }
    if (["complete", "partial", "uncertain"].includes(current.view.status)) return serializeOutlookCleanupJob(current);
    throw new OutlookCleanupError("This Outlook cleanup is not ready for confirmation.", 409);
  }
  const updated = await store.compareAndSet(session.userId, jobId, current.version, (job) => {
    job.view.status = "running";
    job.view.updatedAt = Date.now();
    job.view.expiresAt = cleanupStateExpiryFor({ now: Date.now(), undoAvailable: false, terminal: false });
    job.payload.confirmedAt = Date.now();
    return job;
  });
  if (!updated) throw new OutlookCleanupError("Outlook cleanup state changed. Try again.", 409);
  await startProviderCleanupWorkflow(jobId, "cleanup");
  return serializeOutlookCleanupJob(updated);
}

export async function undoOutlookCleanup(jobId: string) {
  assertGate(1);
  const session = await requireSession();
  const store = createPrismaOutlookCleanupStore();
  const current = await store.get(session.userId, jobId);
  if (!current || current.provider !== "microsoft") throw new OutlookCleanupError("Outlook cleanup job expired.", 410);
  normalizeOutlookCleanupMetrics(current);
  if (current.view.status === "undoing") {
    await startProviderCleanupWorkflow(jobId, "undo");
    return serializeOutlookCleanupJob(current);
  }
  if (current.view.status === "undo_complete") return serializeOutlookCleanupJob(current);
  if (current.view.uncertain > 0 || current.view.status === "uncertain") {
    throw new OutlookCleanupError("Undo is blocked because an Outlook mutation result is uncertain.", 409);
  }
  const restorable = current.payload.targets.filter((target) => target.state === "moved_verified");
  if (!current.view.undoAvailable || restorable.length === 0) {
    throw new OutlookCleanupError("No exact verified Outlook messages are available for Undo.", 409);
  }
  const updated = await store.compareAndSet(session.userId, jobId, current.version, (job) => {
    job.view.status = "undoing";
    job.view.undoAvailable = false;
    job.view.undoStatus = "running";
    job.view.undoBatchesCompleted = 0;
    job.view.undoTotalBatches = Math.ceil(restorable.length / job.view.effectiveBatchSize);
    job.view.updatedAt = Date.now();
    job.view.expiresAt = cleanupStateExpiryFor({ now: Date.now(), undoAvailable: true, terminal: false });
    return job;
  });
  if (!updated) throw new OutlookCleanupError("Outlook cleanup state changed. Try Undo again.", 409);
  await startProviderCleanupWorkflow(jobId, "undo");
  return serializeOutlookCleanupJob(updated);
}

export async function advanceOutlookCleanupJob(jobId: string, operation: "prepare" | "cleanup" | "undo") {
  const store = createPrismaOutlookCleanupStore();
  const owner = randomUUID();
  let job = await store.claim(jobId, owner, new Date(), 10 * 60 * 1000);
  if (!job || job.provider !== "microsoft") return { outcome: "stop" as const };
  try {
    normalizeOutlookCleanupMetrics(job);
    const active = await getActiveMicrosoftConnection(job.userId, job.payload.providerConnectionId);
    if (!active) return await failJob(job, owner);
    const provider = new MicrosoftProvider(active.accessToken, {
      refreshAccessToken: () => forceRefreshMicrosoftConnection(job!.userId, job!.payload.providerConnectionId),
      requestCoordinator: createProviderRequestCoordinator(active.connection.id)
    });
    const baseRequests = job.view.httpRoundTrips;
    const baseSubrequests = job.view.graphSubrequests;
    const baseRetries = job.view.retries;
    const syncMetrics = () => {
      const metrics = provider.getScanMetrics();
      job!.view.graphRequests = baseRequests + metrics.requests;
      job!.view.httpRoundTrips = baseRequests + metrics.requests;
      job!.view.graphSubrequests = baseSubrequests + metrics.subrequests;
      job!.view.retries = baseRetries + metrics.retries;
    };
    const save = async () => {
      syncMetrics();
      job!.view.updatedAt = Date.now();
      const currentJob = job!;
      const next = await store.compareAndSet(currentJob.userId, jobId, currentJob.version, () => currentJob, new Date(), owner);
      if (!next) throw new OutlookCleanupError("Outlook cleanup state changed during execution.", 409);
      currentJob.version = next.version;
      job = currentJob;
      await store.refreshLock(jobId, owner, new Date(), 10 * 60 * 1000);
    };

    const result = operation === "prepare"
      ? (await prepareOutlookJob(job, provider, save), { outcome: "stop" as const })
      : operation === "cleanup"
        ? await executeOutlookMoves(job, provider, save, async () => {
            await markLiveReportStale(job!.userId, "microsoft");
          }, 1)
        : await executeOutlookUndo(job, provider, save, 1);
    syncMetrics();
    await updateAggregateCleanupRow(job);
    return result;
  } catch {
    if (job) {
      const ambiguous = job.payload.targets.some((target) =>
        ["move_dispatching", "move_dispatched", "restore_dispatching", "restore_dispatched"].includes(target.state)
      );
      job.view.status = ambiguous ? "uncertain" : "failed";
      if (ambiguous) job.view.uncertain += 1;
      const recoverable = job.payload.targets.filter((target) => target.state === "moved_verified").length;
      job.view.undoAvailable = !ambiguous && recoverable > 0;
      job.view.undoStatus = ambiguous ? "uncertain" : job.view.undoAvailable ? "available" : "not_available";
      await store.compareAndSet(job.userId, jobId, job.version, (value) => {
        void value;
        return job!;
      }, new Date(), owner).catch(() => undefined);
      await updateAggregateCleanupRow(job).catch(() => undefined);
    }
    return { outcome: "stop" as const };
  } finally {
    await store.releaseLock(jobId, owner).catch(() => false);
  }
}

export async function prepareOutlookJob(
  job: OutlookCleanupStoredJob,
  provider: OutlookCleanupProviderPort,
  save: () => Promise<void>
) {
  if (!job.payload.targets.length && (job.view.status === "created" || job.view.status === "resolving")) {
    job.view.status = "resolving";
    await save();
    normalizeOutlookCleanupMetrics(job);
    const targets = await measureOutlookCleanupPhase(job, provider, "preflight", async () => {
      const selected = new Map(job.payload.selectedSenders.map((sender) => [sender.senderKey.toLowerCase(), sender.groupIndex]));
      const participated = await provider.scanParticipatedConversationIds({ batchSize: 100 });
      job.payload.participatedConversationIds = [...participated];
      const frozenTargets: OutlookCleanupTarget[] = [];
      const seenMessageIds = new Set<string>();
      for await (const batch of provider.scanMetadata({ batchSize: 100, limit: "full" })) {
        for (const record of batch.records) {
          const groupIndex = selected.get(record.senderAddress.toLowerCase());
          if (groupIndex === undefined) continue;
          if (!assessMessage(record, { participatedConversationIds: participated }).eligibleForCleanup) continue;
          if (seenMessageIds.has(record.providerMessageId)) continue;
          seenMessageIds.add(record.providerMessageId);
          frozenTargets.push({ originalMessageId: record.providerMessageId, groupIndex, state: "frozen" });
          if (frozenTargets.length === job.view.requested) break;
        }
        if (frozenTargets.length === job.view.requested) break;
      }
      return frozenTargets;
    });
    if (targets.length !== job.view.requested) {
      job.view.status = "failed";
      job.view.failed = job.view.requested;
    } else {
      job.payload.targets = targets;
      job.view.status = "ready";
    }
    await save();
  }
}

export async function executeOutlookMoves(
  job: OutlookCleanupStoredJob,
  provider: OutlookCleanupProviderPort,
  save: () => Promise<void>,
  onMutationAttempted: () => void | Promise<void> = () => undefined,
  maxBatches = Number.POSITIVE_INFINITY
) {
  if (job.view.status !== "running") return { outcome: "stop" as const };
  normalizeOutlookCleanupMetrics(job);
  for (const target of job.payload.targets) {
    if (target.state === "move_dispatching" && target.movedMessageId) target.state = "move_dispatched";
  }
  if (job.payload.targets.some((target) => target.state === "move_dispatching" && !target.movedMessageId)) {
    job.view.status = "uncertain";
    job.view.uncertain += 1;
    job.view.undoAvailable = false;
    job.view.undoStatus = "uncertain";
    await save();
    return { outcome: "stop" as const };
  }
  const selected = new Map(job.payload.selectedSenders.map((sender) => [sender.senderKey.toLowerCase(), sender.groupIndex]));
  if (!job.payload.cleanupSafetyContext) {
    const { safetyContext, participated } = await measureOutlookCleanupPhase(job, provider, "preflight", async () => {
      const [participated, safetyContext] = await Promise.all([
        provider.scanParticipatedConversationIds({ batchSize: 100 }),
        provider.getCleanupSafetyContext()
      ]);
      return { participated, safetyContext };
    });
    job.payload.participatedConversationIds = [...participated];
    job.payload.cleanupSafetyContext = safetyContext;
    await save();
  }
  const safetyContext = job.payload.cleanupSafetyContext!;
  const participated = new Set(job.payload.participatedConversationIds);
  let advancedBatches = 0;

  while (advancedBatches < maxBatches) {
    if (job.payload.activeMoveBatchIndexes?.length) {
      const verified = await verifyActiveMoveBatch(job, provider, safetyContext.deletedItemsFolderId, save);
      if (!verified) return { outcome: "stop" as const };
      advancedBatches += 1;
      continue;
    }

    const targetChunk = job.payload.targets.filter((target) => target.state === "frozen").slice(0, job.view.effectiveBatchSize);
    if (targetChunk.length === 0) return await finishOutlookCleanup(job, save);
    job.view.currentBatch = Math.min(job.view.totalBatches, job.view.batchesCompleted + 1);
    job.view.currentChunk = Math.ceil(
      job.view.currentBatch / Math.ceil(outlookCleanupChunkSize / job.view.effectiveBatchSize)
    );
    let currentMessages;
    try {
      currentMessages = await measureOutlookCleanupPhase(job, provider, "finalRecheck", () =>
        provider.getCleanupMessages(targetChunk.map((target) => target.originalMessageId), safetyContext)
      );
    } catch {
      for (const target of targetChunk) {
        target.state = "recheck_uncertain";
        job.view.uncertain += 1;
      }
      job.view.checked += targetChunk.length;
      job.view.status = "uncertain";
      job.view.undoAvailable = false;
      job.view.undoStatus = "uncertain";
      await save();
      return { outcome: "stop" as const };
    }

    const approvedTargets: OutlookCleanupTarget[] = [];
    for (const [index, target] of targetChunk.entries()) {
      job.view.checked += 1;
      const current = currentMessages[index];
      if (!current) {
        target.state = "excluded";
        job.view.excludedBySafety += 1;
        continue;
      }
      const groupIndex = selected.get(current.record.senderAddress.toLowerCase());
      const assessed = assessMessage(current.record, { participatedConversationIds: participated });
      if (groupIndex !== target.groupIndex || !assessed.eligibleForCleanup) {
        target.state = "excluded";
        job.view.excludedBySafety += 1;
        continue;
      }
      target.originalFolderId = current.parentFolderId;
      target.state = "move_dispatching";
      job.view.approved += 1;
      approvedTargets.push(target);
    }
    job.payload.activeMoveBatchIndexes = targetChunk.map((target) => job.payload.targets.indexOf(target));
    await save();
    if (approvedTargets.length === 0) {
      completeMoveBatch(job);
      await save();
      advancedBatches += 1;
      continue;
    }

    await onMutationAttempted();
    let moveResults;
    try {
      moveResults = await measureOutlookCleanupPhase(job, provider, "move", () =>
        provider.moveCleanupMessages(
          approvedTargets.map((target) => ({
            messageId: target.originalMessageId,
            destinationFolderId: safetyContext.deletedItemsFolderId
          })),
          "cleanup_move"
        )
      );
    } catch {
      for (const target of approvedTargets) {
        target.state = "move_uncertain";
        job.view.uncertain += 1;
      }
      job.view.status = "uncertain";
      job.view.undoAvailable = false;
      job.view.undoStatus = "uncertain";
      await save();
      return { outcome: "stop" as const };
    }

    const movedTargets: OutlookCleanupTarget[] = [];
    for (const [index, target] of approvedTargets.entries()) {
      const result = moveResults[index];
      if (result.outcome === "success") {
        target.movedMessageId = result.messageId;
        target.state = "move_dispatched";
        movedTargets.push(target);
      } else if (result.outcome === "rejected") {
        target.state = "move_failed";
        job.view.failed += 1;
      } else {
        target.state = "move_uncertain";
        job.view.uncertain += 1;
      }
    }
    await save();
    void movedTargets;
    const verified = await verifyActiveMoveBatch(job, provider, safetyContext.deletedItemsFolderId, save);
    if (!verified) return { outcome: "stop" as const };
    advancedBatches += 1;
  }
  return job.payload.targets.some((target) => target.state === "frozen" || target.state === "move_dispatched")
    ? { outcome: "continue" as const }
    : finishOutlookCleanup(job, save);
}

export async function executeOutlookUndo(
  job: OutlookCleanupStoredJob,
  provider: OutlookCleanupProviderPort,
  save: () => Promise<void>,
  maxBatches = Number.POSITIVE_INFINITY
) {
  if (job.view.status !== "undoing") return { outcome: "stop" as const };
  normalizeOutlookCleanupMetrics(job);
  for (const target of job.payload.targets) {
    if (target.state === "restore_dispatching" && target.restoredMessageId) target.state = "restore_dispatched";
  }
  if (job.payload.targets.some((target) => target.state === "restore_dispatching" && !target.restoredMessageId)) {
    job.view.status = "uncertain";
    job.view.undoStatus = "uncertain";
    job.view.uncertain += 1;
    await save();
    return { outcome: "stop" as const };
  }
  let advancedBatches = 0;
  if (job.view.undoTotalBatches === 0) {
    const remaining = job.payload.targets.filter((target) => target.state === "moved_verified").length;
    job.view.undoTotalBatches = Math.ceil(remaining / job.view.effectiveBatchSize);
  }
  while (advancedBatches < maxBatches) {
    if (job.payload.activeUndoBatchIndexes?.length) {
      const verified = await verifyActiveUndoBatch(job, provider, save);
      if (!verified) return { outcome: "stop" as const };
      advancedBatches += 1;
      continue;
    }
    const targetChunk = job.payload.targets.filter((target) =>
      target.state === "moved_verified" && Boolean(target.movedMessageId) && Boolean(target.originalFolderId)
    ).slice(0, job.view.effectiveBatchSize);
    if (targetChunk.length === 0) return await finishOutlookUndo(job, save);
    job.payload.activeUndoBatchIndexes = targetChunk.map((target) => job.payload.targets.indexOf(target));
    for (const target of targetChunk) target.state = "restore_dispatching";
    await save();
    let restoreResults;
    try {
      restoreResults = await measureOutlookCleanupPhase(job, provider, "undoMove", () =>
        provider.moveCleanupMessages(
          targetChunk.map((target) => ({
            messageId: target.movedMessageId!,
            destinationFolderId: target.originalFolderId!
          })),
          "cleanup_restore"
        )
      );
    } catch {
      for (const target of targetChunk) {
        target.state = "restore_uncertain";
        job.view.uncertain += 1;
      }
      job.view.status = "uncertain";
      job.view.undoAvailable = false;
      job.view.undoStatus = "uncertain";
      await save();
      return { outcome: "stop" as const };
    }

    const restoredTargets: OutlookCleanupTarget[] = [];
    for (const [index, target] of targetChunk.entries()) {
      const result = restoreResults[index];
      if (result.outcome === "success") {
        target.restoredMessageId = result.messageId;
        target.state = "restore_dispatched";
        restoredTargets.push(target);
      } else if (result.outcome === "rejected") {
        target.state = "restore_failed";
        job.view.failed += 1;
      } else {
        target.state = "restore_uncertain";
        job.view.uncertain += 1;
      }
    }
    await save();
    void restoredTargets;
    const verified = await verifyActiveUndoBatch(job, provider, save);
    if (!verified) return { outcome: "stop" as const };
    advancedBatches += 1;
  }
  return job.payload.targets.some((target) => target.state === "moved_verified" || target.state === "restore_dispatched")
    ? { outcome: "continue" as const }
    : finishOutlookUndo(job, save);
}

async function verifyActiveMoveBatch(
  job: OutlookCleanupStoredJob,
  provider: OutlookCleanupProviderPort,
  deletedItemsFolderId: string,
  save: () => Promise<void>
) {
  const activeTargets = (job.payload.activeMoveBatchIndexes ?? [])
    .map((index) => job.payload.targets[index])
    .filter(Boolean);
  const dispatchedTargets = activeTargets.filter((target) =>
    target.state === "move_dispatched" && Boolean(target.movedMessageId)
  );
  if (dispatchedTargets.length > 0) {
    let verifiedResults: boolean[];
    try {
      verifiedResults = await measureOutlookCleanupPhase(job, provider, "verification", () =>
        provider.verifyCleanupMessageLocations(
          dispatchedTargets.map((target) => ({
            messageId: target.movedMessageId!,
            destinationFolderId: deletedItemsFolderId
          })),
          "cleanup_move_verify"
        )
      );
    } catch {
      verifiedResults = dispatchedTargets.map(() => false);
    }
    for (const [index, target] of dispatchedTargets.entries()) {
      if (verifiedResults[index]) {
        target.state = "moved_verified";
        job.view.movedVerified += 1;
      } else {
        target.state = "move_uncertain";
        job.view.uncertain += 1;
      }
    }
  }
  if (job.view.uncertain > 0) {
    job.view.status = "uncertain";
    job.view.undoAvailable = false;
    job.view.undoStatus = "uncertain";
    await save();
    return false;
  }
  completeMoveBatch(job);
  await save();
  return true;
}

function completeMoveBatch(job: OutlookCleanupStoredJob) {
  job.payload.activeMoveBatchIndexes = undefined;
  job.view.batchesCompleted = Math.min(job.view.totalBatches, job.view.batchesCompleted + 1);
  refreshCleanupProgress(job);
}

async function finishOutlookCleanup(job: OutlookCleanupStoredJob, save: () => Promise<void>) {
  job.view.undoAvailable = job.view.movedVerified > 0 && job.view.uncertain === 0;
  job.view.undoStatus = job.view.uncertain > 0 ? "uncertain" : job.view.undoAvailable ? "available" : "not_available";
  job.view.status = job.view.uncertain > 0 ? "uncertain" : job.view.failed > 0 ? "partial" : "complete";
  job.view.expiresAt = cleanupStateExpiryFor({ now: Date.now(), undoAvailable: job.view.undoAvailable, terminal: false });
  refreshCleanupProgress(job);
  await save();
  return { outcome: "stop" as const };
}

async function verifyActiveUndoBatch(
  job: OutlookCleanupStoredJob,
  provider: OutlookCleanupProviderPort,
  save: () => Promise<void>
) {
  const activeTargets = (job.payload.activeUndoBatchIndexes ?? [])
    .map((index) => job.payload.targets[index])
    .filter(Boolean);
  const dispatchedTargets = activeTargets.filter((target) =>
    target.state === "restore_dispatched" && Boolean(target.restoredMessageId) && Boolean(target.originalFolderId)
  );
  if (dispatchedTargets.length > 0) {
    let verifiedResults: boolean[];
    try {
      verifiedResults = await measureOutlookCleanupPhase(job, provider, "undoVerification", () =>
        provider.verifyCleanupMessageLocations(
          dispatchedTargets.map((target) => ({
            messageId: target.restoredMessageId!,
            destinationFolderId: target.originalFolderId!
          })),
          "cleanup_restore_verify"
        )
      );
    } catch {
      verifiedResults = dispatchedTargets.map(() => false);
    }
    for (const [index, target] of dispatchedTargets.entries()) {
      if (verifiedResults[index]) {
        target.state = "restored_verified";
        job.view.restoredVerified += 1;
      } else {
        target.state = "restore_uncertain";
        job.view.uncertain += 1;
      }
    }
  }
  if (job.view.uncertain > 0) {
    job.view.status = "uncertain";
    job.view.undoAvailable = false;
    job.view.undoStatus = "uncertain";
    await save();
    return false;
  }
  job.payload.activeUndoBatchIndexes = undefined;
  job.view.undoBatchesCompleted = Math.min(job.view.undoTotalBatches, job.view.undoBatchesCompleted + 1);
  await save();
  return true;
}

async function finishOutlookUndo(job: OutlookCleanupStoredJob, save: () => Promise<void>) {
  const remaining = job.payload.targets.filter((target) => target.state === "moved_verified").length;
  job.view.undoAvailable = remaining > 0 && job.view.uncertain === 0;
  job.view.undoStatus = job.view.uncertain > 0
    ? "uncertain"
    : job.view.restoredVerified === job.view.movedVerified
      ? "complete"
      : "partial";
  job.view.status = job.view.undoStatus === "complete" ? "undo_complete" : job.view.uncertain > 0 ? "uncertain" : "partial";
  job.view.expiresAt = cleanupStateExpiryFor({ now: Date.now(), undoAvailable: remaining > 0, terminal: remaining === 0 });
  await save();
  return { outcome: "stop" as const };
}

function refreshCleanupProgress(job: OutlookCleanupStoredJob) {
  const batchesPerChunk = Math.ceil(outlookCleanupChunkSize / job.view.effectiveBatchSize);
  job.view.chunksCompleted = job.view.batchesCompleted === job.view.totalBatches
    ? job.view.totalChunks
    : Math.floor(job.view.batchesCompleted / batchesPerChunk);
  if (job.view.batchesCompleted >= job.view.totalBatches) {
    job.view.currentBatch = job.view.totalBatches;
    job.view.currentChunk = job.view.totalChunks;
  } else {
    job.view.currentBatch = job.view.batchesCompleted + 1;
    job.view.currentChunk = Math.ceil(job.view.currentBatch / batchesPerChunk);
  }
}

function normalizeOutlookCleanupMetrics(job: OutlookCleanupStoredJob) {
  if (!job.view.effectiveBatchSize) {
    const adaptiveBatchSize = getOutlookCleanupBatchSize(job.view.requested);
    const legacyTotalBatches = Math.ceil(job.view.requested / 5);
    job.view.effectiveBatchSize = job.view.totalBatches === legacyTotalBatches &&
      legacyTotalBatches !== Math.ceil(job.view.requested / adaptiveBatchSize)
      ? 5
      : adaptiveBatchSize;
  }
  job.view.httpRoundTrips ??= job.view.graphRequests ?? 0;
  job.view.graphSubrequests ??= job.view.graphRequests ?? 0;
  job.view.graphRequests = job.view.httpRoundTrips;
  job.view.httpRoundTripsByPhase ??= createEmptyOutlookCleanupHttpRoundTrips();
  job.view.timingMs ??= createEmptyOutlookCleanupTiming();
  job.view.checked ??= job.view.approved + job.view.excludedBySafety;
  job.view.totalChunks ??= Math.ceil(job.view.requested / outlookCleanupChunkSize);
  job.view.totalBatches ??= Math.ceil(job.view.requested / job.view.effectiveBatchSize);
  job.view.chunksCompleted ??= 0;
  job.view.batchesCompleted ??= 0;
  job.view.currentChunk ??= 0;
  job.view.currentBatch ??= 0;
  job.view.undoBatchesCompleted ??= 0;
  job.view.undoTotalBatches ??= 0;
}

async function measureOutlookCleanupPhase<T>(
  job: OutlookCleanupStoredJob,
  provider: OutlookCleanupProviderPort,
  phase: keyof OutlookCleanupStoredJob["view"]["timingMs"],
  operation: () => Promise<T>
) {
  const started = performance.now();
  const requestsBefore = provider.getScanMetrics?.().requests ?? 0;
  try {
    return await operation();
  } finally {
    addOutlookCleanupTiming(job, phase, started);
    const requestsAfter = provider.getScanMetrics?.().requests ?? requestsBefore;
    job.view.httpRoundTripsByPhase ??= createEmptyOutlookCleanupHttpRoundTrips();
    job.view.httpRoundTripsByPhase[phase] += Math.max(0, requestsAfter - requestsBefore);
  }
}

function addOutlookCleanupTiming(
  job: OutlookCleanupStoredJob,
  phase: keyof OutlookCleanupStoredJob["view"]["timingMs"],
  started: number
) {
  job.view.timingMs ??= createEmptyOutlookCleanupTiming();
  job.view.timingMs[phase] = Math.round(job.view.timingMs[phase] + performance.now() - started);
}

async function updateAggregateCleanupRow(job: OutlookCleanupStoredJob) {
  const status = job.view.status === "complete" || job.view.status === "undo_complete"
    ? "completed"
    : job.view.status === "failed"
      ? "failed"
      : ["partial", "uncertain"].includes(job.view.status)
        ? "partial"
        : "running";
  const terminal = ["complete", "partial", "uncertain", "failed", "undo_complete"].includes(job.view.status);
  await prisma.cleanupJob.updateMany({
    where: { id: job.view.id },
    data: {
      status,
      startedAt: new Date(job.payload.confirmedAt ?? job.view.createdAt),
      completedAt: terminal ? new Date() : null,
      failureCode: job.view.uncertain > 0 ? "OUTLOOK_MUTATION_UNCERTAIN" : job.view.failed > 0 ? "OUTLOOK_PARTIAL_FAILURE" : null,
      failureMessage: null,
      terminalState: terminal ? job.view.status : null,
      terminalSnapshot: terminal ? serializeOutlookCleanupJob(job) : undefined,
      terminalSnapshotVersion: terminal ? 1 : 0
    }
  });
}

async function failJob(job: OutlookCleanupStoredJob, owner: string) {
  const store = createPrismaOutlookCleanupStore();
  job.view.status = "failed";
  const unprocessed = job.payload.targets.filter((target) => target.state === "frozen").length;
  job.view.failed = Math.max(job.view.failed, unprocessed);
  const recoverable = job.payload.targets.filter((target) => target.state === "moved_verified").length;
  job.view.undoAvailable = recoverable > 0 && job.view.uncertain === 0;
  job.view.undoStatus = job.view.undoAvailable ? "available" : "not_available";
  await store.compareAndSet(job.userId, job.view.id, job.version, () => job, new Date(), owner);
  await updateAggregateCleanupRow(job);
  return { outcome: "stop" as const };
}

function parseGroupIndices(value: unknown, groupCount: number) {
  if (!Array.isArray(value) || value.length === 0) throw new OutlookCleanupError("Select at least one sender group.", 400);
  const result = [...new Set(value.map(Number))];
  if (result.some((index) => !Number.isInteger(index) || index < 0 || index >= groupCount)) {
    throw new OutlookCleanupError("The sender-group selection is invalid.", 400);
  }
  return result;
}

function isOutlookCleanupEnabled() {
  return isOutlookCleanupDevelopmentEnabled({
    microsoftOAuthEnabled: runtimeConfig.microsoftOAuthDevEnabled,
    outlookCleanupEnabled: runtimeConfig.outlookCleanupDevEnabled,
    fixtureMode: runtimeConfig.fixtureMode,
    nodeEnv: process.env.NODE_ENV
  });
}

function assertGate(requestedCount: unknown) {
  try {
    return assertOutlookCleanupDevelopmentRequest({
      enabled: runtimeConfig.microsoftOAuthDevEnabled && runtimeConfig.outlookCleanupDevEnabled,
      fixtureMode: runtimeConfig.fixtureMode,
      nodeEnv: process.env.NODE_ENV,
      requestedCount
    });
  } catch (error) {
    throw new OutlookCleanupError(error instanceof Error ? error.message : "Outlook cleanup is disabled.", 403);
  }
}

async function requireSession() {
  const session = await getSession();
  if (!session?.userId) throw new OutlookCleanupError("Connect Microsoft before cleanup.", 401);
  return session;
}
