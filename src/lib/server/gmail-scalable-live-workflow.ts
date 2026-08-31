import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  assertGmailScalableTransition,
  createGmailScalableChunkViews,
  gmailScalableProgressLabel,
  summarizeGmailScalableChunks,
  type GmailScalableJobView
} from "@/lib/domain/gmail-scalable-cleanup";
import {
  parseGmailScalableTerminalSnapshot,
  terminalSnapshotToGmailScalableJobView
} from "@/lib/domain/gmail-scalable-terminal-snapshot";
import type { CleanupSenderGroup } from "@/lib/providers/gmail/cleanup-candidates";
import { gmailScalePolicy } from "@/lib/providers/gmail/scale-architecture";
import {
  allocateGmailScalableCleanupTargets,
  type GmailScalableCleanupTarget
} from "@/lib/providers/gmail/scalable-targets";
import { sha256Base64Url } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import {
  cleanupStateExpiryFor,
  createPrismaGmailScalableCleanupStore
} from "@/lib/server/gmail-scalable-cleanup-durable-store";
import { GmailScalableCleanupError } from "@/lib/server/gmail-scalable-cleanup-runner";
import { prepareGmailScalableJobForConfirmedCleanup } from "@/lib/server/gmail-scalable-workflow-executor";
import {
  getGmailScalableRestoreEligibility,
  serializeGmailScalableJob,
  type GmailScalableStoredJob
} from "@/lib/server/gmail-scalable-cleanup-store";
import {
  startGmailScalableCleanupWorkflow,
  startGmailScalableUndoWorkflow
} from "@/lib/server/gmail-scalable-workflow-start";

const activeStatuses = new Set(["created", "safety_checking", "ready", "mutating", "verifying", "chunk_complete", "paused", "complete", "undoing"]);

export async function acceptDurableGmailScalableCleanup(input: {
  userId: string;
  providerConnectionId?: string;
  scanId: string;
  uidValidity: string;
  requestedCount: 250 | 500;
  groupIndices: readonly number[];
  groups: readonly CleanupSenderGroup[];
  targets: readonly GmailScalableCleanupTarget[];
}) {
  const groupIndices = [...input.groupIndices];
  const selectedGroups = groupIndices.map((index) => input.groups[index]);
  if (selectedGroups.some((group) => !group?.eligible)) {
    throw new GmailScalableCleanupError("Every selected sender group must still be eligible for cleanup.", 409);
  }
  const allocatedTargets = allocateGmailScalableCleanupTargets(selectedGroups, input.targets, input.requestedCount);
  if (allocatedTargets.length !== input.requestedCount) {
    throw new GmailScalableCleanupError(`The fresh scan no longer contains ${input.requestedCount} exact Suggested messages for this selection.`, 409);
  }

  const acceptanceKey = sha256Base64Url(
    JSON.stringify([input.scanId, [...groupIndices].sort((left, right) => left - right), input.requestedCount])
  );
  const store = createPrismaGmailScalableCleanupStore();
  const existing = await findActiveDurableJob(input.userId, acceptanceKey);
  if (existing) return serializeGmailScalableJob(existing);

  const connection = await prisma.providerConnection.findFirst({
    where: {
      id: input.providerConnectionId,
      userId: input.userId,
      provider: "gmail",
      disconnectedAt: null,
      encryptedAccessToken: { not: null },
      encryptedAccountEmail: { not: null }
    },
    select: { id: true }
  });
  if (!connection) throw new GmailScalableCleanupError("An active Gmail connection is required.", 401);

  const now = Date.now();
  const job = createAcceptedJob({ ...input, groupIndices, allocatedTargets, acceptanceKey, now });
  await prisma.$transaction(async (transaction) => {
    await transaction.scan.upsert({
      where: { id: input.scanId },
      update: { status: "completed", completedAt: new Date(now) },
      create: {
        id: input.scanId,
        userId: input.userId,
        providerConnectionId: connection.id,
        provider: "gmail",
        status: "completed",
        startedAt: new Date(now),
        completedAt: new Date(now)
      }
    });
    await transaction.cleanupJob.create({
      data: { id: job.view.id, scanId: input.scanId, status: "pending" }
    });
  });
  try {
    const created = await store.create(job);
    await startGmailScalableCleanupWorkflow(created.view.id);
    return serializeGmailScalableJob(created);
  } catch (error) {
    await store.delete(input.userId, job.view.id).catch(() => false);
    await prisma.cleanupJob.deleteMany({ where: { id: job.view.id } });
    throw error;
  }
}

export async function getDurableGmailScalableCleanupStatus(userId: string, jobId: string) {
  const job = await createPrismaGmailScalableCleanupStore().get(userId, jobId);
  if (job) return serializeGmailScalableJob(job);
  const terminal = await getAggregateTerminalJob(userId, jobId);
  if (terminal) return terminal;
  throw new GmailScalableCleanupError("Scalable cleanup job expired.", 410);
}

export async function getLatestDurableGmailScalableCleanup(userId: string) {
  const rows = await prisma.cleanupJobState.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { jobId: true }
  });
  const store = createPrismaGmailScalableCleanupStore();
  for (const row of rows) {
    const job = await store.get(userId, row.jobId);
    if (job) return serializeGmailScalableJob(job);
  }
  const terminal = await prisma.cleanupJob.findFirst({
    where: { scan: { userId }, terminalState: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, terminalSnapshot: true, terminalSnapshotVersion: true }
  });
  return terminal ? terminalRowToView(terminal) : undefined;
}

export async function confirmDurableGmailScalableCleanup(userId: string, jobId: string) {
  const store = createPrismaGmailScalableCleanupStore();
  const current = await requireJob(userId, jobId);
  if (current.view.status !== "ready") {
    if (["mutating", "verifying", "chunk_complete", "safety_checking", "complete"].includes(current.view.status)) {
      return serializeGmailScalableJob(current);
    }
    throw new GmailScalableCleanupError("This scalable cleanup job is not ready to move messages.", 409);
  }
  const updated = await store.compareAndSet(userId, jobId, current.version, (job) => {
    assertGmailScalableTransition(job.view.status, "safety_checking");
    prepareGmailScalableJobForConfirmedCleanup(job, Date.now());
    job.view.expiresAt = cleanupStateExpiryFor({ now: Date.now(), undoAvailable: false, terminal: false });
    refreshView(job);
    return job;
  });
  if (!updated) throw new GmailScalableCleanupError("Scalable cleanup state changed. Read the current status and try again.", 409);
  await startGmailScalableCleanupWorkflow(jobId);
  return serializeGmailScalableJob(updated);
}

export async function undoDurableGmailScalableCleanup(userId: string, jobId: string) {
  const store = createPrismaGmailScalableCleanupStore();
  const snapshot = await requireJob(userId, jobId);
  if (snapshot.view.status === "undoing" || (snapshot.view.status === "paused" && snapshot.view.restoreMode)) {
    return serializeGmailScalableJob(snapshot);
  }
  const lockOwner = randomUUID();
  const current = await store.claim(jobId, lockOwner);
  if (!current || current.userId !== userId) {
    if (current) await store.releaseLock(jobId, lockOwner);
    throw new GmailScalableCleanupError("Scalable cleanup state is advancing. Read the current status and try restore again.", 409);
  }
  let updated: GmailScalableStoredJob | undefined;
  try {
    const eligibility = getGmailScalableRestoreEligibility(current);
    if (!eligibility.available || !eligibility.mode) {
      throw new GmailScalableCleanupError(eligibility.reason, 409);
    }
    updated = await store.compareAndSet(userId, jobId, current.version, (job) => {
      assertGmailScalableTransition(job.view.status, "undoing");
      job.view.status = "undoing";
      job.view.restoreMode = eligibility.mode;
      job.view.undoAvailable = false;
      job.view.completedAt = undefined;
      job.view.nextEligibleRunAt = undefined;
      job.payload.resumeState = undefined;
      job.payload.undoQuotaStartUnits = job.view.quotaConsumedUnits;
      job.view.expiresAt = cleanupStateExpiryFor({ now: Date.now(), undoAvailable: true, terminal: false });
      for (const sensitive of job.payload.chunks) {
        if (
          sensitive.verifiedMovedIndexes.length > 0 &&
          sensitive.verifiedRestoredIndexes.length === 0 &&
          !sensitive.undoMutationDispatched
        ) {
          job.view.chunks[sensitive.index].status = "undoing";
        }
      }
      refreshView(job);
      return job;
    }, new Date(), lockOwner);
  } finally {
    await store.releaseLock(jobId, lockOwner);
  }
  if (!updated) throw new GmailScalableCleanupError("Scalable restore state changed. Read the current status and try again.", 409);
  await startGmailScalableUndoWorkflow(jobId);
  return serializeGmailScalableJob(updated);
}

export async function discardDurableGmailScalableCleanup(userId: string, jobId: string) {
  const store = createPrismaGmailScalableCleanupStore();
  const current = await requireJob(userId, jobId);
  if (
    !["created", "safety_checking", "ready", "failed"].includes(current.view.status) ||
    (current.view.status === "failed" && getGmailScalableRestoreEligibility(current).available)
  ) {
    throw new GmailScalableCleanupError("Scalable cleanup cannot be discarded after Trash work begins.", 409);
  }
  await store.delete(userId, jobId);
  await prisma.cleanupJob.updateMany({
    where: { id: jobId, status: { in: ["pending", "running"] } },
    data: { status: "cancelled", completedAt: new Date() }
  });
  return true;
}

async function requireJob(userId: string, jobId: string) {
  const job = await createPrismaGmailScalableCleanupStore().get(userId, jobId);
  if (!job) throw new GmailScalableCleanupError("Scalable cleanup job expired.", 410);
  return job;
}

async function getAggregateTerminalJob(userId: string, jobId: string) {
  const row = await prisma.cleanupJob.findFirst({
    where: { id: jobId, scan: { userId }, terminalState: { not: null } },
    select: { id: true, terminalSnapshot: true, terminalSnapshotVersion: true }
  });
  return row ? terminalRowToView(row) : undefined;
}

function terminalRowToView(row: { id: string; terminalSnapshot: Prisma.JsonValue; terminalSnapshotVersion: number }) {
  const snapshot = parseGmailScalableTerminalSnapshot(row.terminalSnapshot);
  return snapshot
    ? terminalSnapshotToGmailScalableJobView({ id: row.id, snapshot, snapshotVersion: row.terminalSnapshotVersion })
    : undefined;
}

async function findActiveDurableJob(userId: string, acceptanceKey: string) {
  const rows = await prisma.cleanupJobState.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { jobId: true }
  });
  const store = createPrismaGmailScalableCleanupStore();
  for (const row of rows) {
    const job = await store.get(userId, row.jobId);
    if (job?.acceptanceKey === acceptanceKey && activeStatuses.has(job.view.status)) return job;
  }
  return undefined;
}

function createAcceptedJob(input: {
  userId: string;
  scanId: string;
  uidValidity: string;
  requestedCount: 250 | 500;
  groupIndices: readonly number[];
  allocatedTargets: readonly GmailScalableCleanupTarget[];
  acceptanceKey: string;
  now: number;
}): GmailScalableStoredJob {
  const chunks = createGmailScalableChunkViews(input.requestedCount);
  const view: GmailScalableJobView = {
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
    quotaWorkingLimit: 4_500,
    suggestedDeltas: [],
    groupIndices: [...input.groupIndices],
    chunks,
    undoAvailable: false,
    duplicateStartCount: 0,
    duplicateDispatchCount: 0,
    duplicateUndoCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: cleanupStateExpiryFor({ now: input.now, undoAvailable: false, terminal: false })
  };
  return {
    userId: input.userId,
    acceptanceKey: input.acceptanceKey,
    version: 0,
    view,
    payload: {
      scanId: input.scanId,
      uidValidity: input.uidValidity,
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        targets: input.allocatedTargets.slice(chunk.index * 250, (chunk.index + 1) * 250),
        safeTargetIndexes: [],
        verifiedMovedIndexes: [],
        verifiedRestoredIndexes: []
      })),
      quotaWindow: { startedAt: input.now, consumedUnits: 0 }
    }
  };
}

function refreshView(job: GmailScalableStoredJob) {
  const { quotaUnits: _quotaUnits, ...summary } = summarizeGmailScalableChunks(job.view.chunks);
  void _quotaUnits;
  Object.assign(job.view, summary, { updatedAt: Date.now() });
  job.view.progressLabel = gmailScalableProgressLabel(job.view.status, job.view);
}
