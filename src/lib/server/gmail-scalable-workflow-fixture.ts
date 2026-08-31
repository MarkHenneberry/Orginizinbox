import "server-only";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "@/lib/config";
import {
  assertGmailScalableTransition,
  createGmailScalableChunkViews,
  gmailScalableProgressLabel,
  type GmailScalableJobView
} from "@/lib/domain/gmail-scalable-cleanup";
import type { GmailScalableCleanupTarget } from "@/lib/providers/gmail/scalable-targets";
import { prisma } from "@/lib/server/db";
import { createPrismaGmailScalableCleanupStore } from "@/lib/server/gmail-scalable-cleanup-durable-store";
import type {
  GmailScalableFixtureControl,
  GmailScalableStoredJob
} from "@/lib/server/gmail-scalable-cleanup-store";
import { getGmailScalableRestoreEligibility } from "@/lib/server/gmail-scalable-cleanup-store";
import { prepareGmailScalableJobForConfirmedCleanup } from "@/lib/server/gmail-scalable-workflow-executor";

export type GmailScalableWorkflowFixtureOptions = {
  requestedCount: 250 | 500 | 1_000;
  autoConfirm?: boolean;
  mutationOutcome?: GmailScalableFixtureControl["mutationOutcome"];
  mutationOutcomesByChunk?: GmailScalableFixtureControl["mutationOutcomesByChunk"];
  preflightSafetyExcludedCountsByChunk?: number[];
  safetyExcludedCountsByChunk?: number[];
  interruptAfterTrashDispatchChunkIndexes?: number[];
  quotaPauseBeforeCleanupChunkIndexes?: number[];
  quotaPauseBeforeUndoChunkIndexes?: number[];
};

export type GmailScalableWorkflowFixtureIds = {
  userId: string;
  connectionId: string;
  scanId: string;
  jobId: string;
  firstFixtureMessageId: string;
};

export async function createGmailScalableWorkflowFixture(
  options: GmailScalableWorkflowFixtureOptions
): Promise<GmailScalableWorkflowFixtureIds> {
  assertFixtureHarnessEnabled();
  const userId = `fixture-user-${randomUUID()}`;
  const connectionId = `fixture-connection-${randomUUID()}`;
  const scanId = `fixture-scan-${randomUUID()}`;
  const jobId = `fixture-job-${randomUUID()}`;
  const now = Date.now();

  await prisma.$transaction([
    prisma.user.create({ data: { id: userId } }),
    prisma.providerConnection.create({
      data: { id: connectionId, userId, provider: "gmail" }
    }),
    prisma.scan.create({
      data: {
        id: scanId,
        userId,
        providerConnectionId: connectionId,
        provider: "gmail",
        status: "completed",
        startedAt: new Date(now),
        completedAt: new Date(now)
      }
    }),
    prisma.cleanupJob.create({
      data: { id: jobId, scanId, status: "pending" }
    })
  ]);

  const job = createFixtureStoredJob({ ...options, userId, scanId, jobId, now });
  try {
    await createPrismaGmailScalableCleanupStore().create(job);
  } catch (error) {
    await prisma.user.deleteMany({ where: { id: userId } });
    throw error;
  }
  return {
    userId,
    connectionId,
    scanId,
    jobId,
    firstFixtureMessageId: job.payload.chunks[0].targets[0].apiMessageId
  };
}

export async function prepareGmailScalableWorkflowFixtureUndo(userId: string, jobId: string) {
  assertFixtureHarnessEnabled();
  const store = createPrismaGmailScalableCleanupStore();
  const current = await store.get(userId, jobId);
  if (!current) throw new Error("The fixture cleanup is unavailable.");
  const eligibility = getGmailScalableRestoreEligibility(current);
  if (!eligibility.available || !eligibility.mode) throw new Error(eligibility.reason);
  const updated = await store.compareAndSet(userId, jobId, current.version, (job) => {
    assertGmailScalableTransition(job.view.status, "undoing");
    job.view.status = "undoing";
    job.view.restoreMode = eligibility.mode;
    job.view.undoAvailable = false;
    job.view.completedAt = undefined;
    job.payload.undoQuotaStartUnits = job.view.quotaConsumedUnits;
    for (const sensitive of job.payload.chunks) {
      if (
        sensitive.verifiedMovedIndexes.length > 0 &&
        sensitive.verifiedRestoredIndexes.length === 0 &&
        !sensitive.undoMutationDispatched
      ) {
        job.view.chunks[sensitive.index].status = "undoing";
      }
    }
    job.view.updatedAt = Date.now();
    job.view.progressLabel = gmailScalableProgressLabel("undoing", job.view);
    return job;
  });
  if (!updated) throw new Error("Fixture Undo could not claim the current state version.");
  return updated;
}

export async function confirmGmailScalableWorkflowFixture(userId: string, jobId: string) {
  assertFixtureHarnessEnabled();
  const store = createPrismaGmailScalableCleanupStore();
  const current = await store.get(userId, jobId);
  if (!current || current.view.status !== "ready") throw new Error("The fixture cleanup is not ready for confirmation.");
  const updated = await store.compareAndSet(userId, jobId, current.version, (job) =>
    prepareGmailScalableJobForConfirmedCleanup(job, Date.now())
  );
  if (!updated) throw new Error("Fixture confirmation could not claim the current state version.");
  return updated;
}

export async function deleteGmailScalableWorkflowFixture(userId: string) {
  return prisma.user.deleteMany({ where: { id: userId } });
}

export async function getGmailScalableWorkflowFixtureAggregate(jobId: string) {
  return prisma.cleanupJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      failureCode: true,
      failureMessage: true,
      terminalState: true,
      terminalSnapshot: true,
      terminalSnapshotVersion: true,
      startedAt: true,
      completedAt: true
    }
  });
}

export function assertFixtureHarnessEnabled() {
  if (
    process.env.NODE_ENV === "production" ||
    !runtimeConfig.fixtureMode ||
    !runtimeConfig.gmailScalableWorkflowFixtureEnabled ||
    runtimeConfig.gmailScalableStoreAdapter !== "prisma" ||
    !runtimeConfig.gmailScalableWorkflowEnabled
  ) {
    throw new Error("The Prisma Workflow fixture harness is disabled.");
  }
}

function createFixtureStoredJob(input: GmailScalableWorkflowFixtureOptions & {
  userId: string;
  scanId: string;
  jobId: string;
  now: number;
}): GmailScalableStoredJob {
  const chunks = createGmailScalableChunkViews(input.requestedCount);
  const targets = Array.from({ length: input.requestedCount }, (_, index) => fixtureTarget(input.jobId, index));
  const viewBase = {
    id: input.jobId,
    status: "created" as const,
    requestedCount: input.requestedCount,
    chunkSize: 250,
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
    progressLabel: "Fixture cleanup accepted.",
    quotaConsumedUnits: 0,
    developmentAuditQuotaUnits: 0,
    quotaWorkingLimit: 4_500,
    suggestedDeltas: [],
    groupIndices: [0],
    chunks,
    undoAvailable: false,
    duplicateStartCount: 0,
    duplicateDispatchCount: 0,
    duplicateUndoCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: input.now + 30 * 60_000
  } satisfies GmailScalableJobView;
  return {
    userId: input.userId,
    acceptanceKey: `fixture-acceptance-${input.jobId}`,
    version: 0,
    view: viewBase,
    payload: {
      scanId: input.scanId,
      uidValidity: `fixture-uid-validity-${input.jobId}`,
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        targets: targets.slice(chunk.index * 250, (chunk.index + 1) * 250),
        safeTargetIndexes: [],
        verifiedMovedIndexes: [],
        verifiedRestoredIndexes: []
      })),
      quotaWindow: { startedAt: input.now, consumedUnits: 0 },
      fixture: {
        enabled: true,
        autoConfirm: input.autoConfirm ?? true,
        mutationOutcome: input.mutationOutcome ?? "applied",
        mutationOutcomesByChunk: input.mutationOutcomesByChunk ?? [],
        preflightSafetyExcludedCountsByChunk: input.preflightSafetyExcludedCountsByChunk ?? input.safetyExcludedCountsByChunk ?? [],
        safetyExcludedCountsByChunk: input.safetyExcludedCountsByChunk ?? [],
        interruptAfterTrashDispatchChunkIndexes: input.interruptAfterTrashDispatchChunkIndexes ?? [],
        quotaPauseBeforeCleanupChunkIndexes: input.quotaPauseBeforeCleanupChunkIndexes ?? [],
        quotaPauseBeforeUndoChunkIndexes: input.quotaPauseBeforeUndoChunkIndexes ?? [],
        consumedCleanupQuotaPauses: [],
        consumedUndoQuotaPauses: [],
        operationLedger: [],
        verifiedProgress: [],
        restoredProgress: []
      }
    }
  };
}

function fixtureTarget(jobId: string, index: number): GmailScalableCleanupTarget {
  return {
    uid: index + 1,
    apiMessageId: `fixture-message-${jobId}-${String(index + 1).padStart(5, "0")}`,
    groupIndex: 0,
    immutableEvidence: {
      eligibleAtScan: true,
      subjectProtected: false,
      participatedConversation: false,
      protectedAtScan: false,
      ageBand: "very_old",
      cleanupSignals: ["HAS_LIST_ID"]
    }
  };
}
