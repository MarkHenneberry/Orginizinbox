import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { formatGmailScalableDevelopmentSummary } from "@/lib/domain/gmail-scalable-cleanup";
import { createGmailScalableTerminalSnapshot } from "@/lib/domain/gmail-scalable-terminal-snapshot";
import {
  markGmailScalableMutationDispatch,
  planGmailScalableWorkflowStep,
  type GmailScalableWorkflowMode,
  type GmailScalableWorkflowOperation
} from "@/lib/domain/gmail-scalable-workflow";
import {
  cleanupStateExpiryFor,
  createPrismaGmailScalableCleanupStore,
  type GmailScalableDurableCleanupStore
} from "@/lib/server/gmail-scalable-cleanup-durable-store";
import {
  exactVerifiedMovedLedgerCount,
  serializeGmailScalableJob,
  type GmailScalableStoredJob
} from "@/lib/server/gmail-scalable-cleanup-store";
import { GmailScalableProviderWorkflowExecutor } from "@/lib/server/gmail-scalable-workflow-executor";
import { prisma } from "@/lib/server/db";

export type GmailScalableWorkflowOperationExecutor = {
  execute(input: {
    job: GmailScalableStoredJob;
    operation: GmailScalableWorkflowOperation;
  }): Promise<GmailScalableStoredJob>;
};

export type GmailScalableWorkflowStepResult = {
  outcome: "continue" | "sleep" | "stop";
  status?: GmailScalableStoredJob["view"]["status"];
  operation?: GmailScalableWorkflowOperation;
  resumeAt?: number;
  reason?: "complete" | "waiting_for_confirmation" | "terminal" | "missing_state" | "locked";
  chunksComplete?: number;
  chunksTotal?: number;
  verifiedCount?: number;
  verifiedRestoredCount?: number;
};

export type GmailScalableAggregateJobWriter = {
  sync(job: GmailScalableStoredJob): Promise<void>;
  markMissingState(jobId: string): Promise<void>;
};

export class GmailScalableWorkflowCoordinator {
  constructor(
    private readonly store: GmailScalableDurableCleanupStore,
    private readonly executor: GmailScalableWorkflowOperationExecutor,
    private readonly now: () => number = Date.now,
    private readonly owner: () => string = randomUUID,
    private readonly aggregateWriter: GmailScalableAggregateJobWriter = {
      sync: async () => undefined,
      markMissingState: async () => undefined
    }
  ) {}

  async advance(cleanupJobId: string, mode: GmailScalableWorkflowMode): Promise<GmailScalableWorkflowStepResult> {
    const now = this.now();
    const lockOwner = this.owner();
    const claimed = await this.store.claim(cleanupJobId, lockOwner, new Date(now));
    if (!claimed) {
      const existing = await this.store.getByJobId(cleanupJobId, new Date(now));
      if (!existing) await this.aggregateWriter.markMissingState(cleanupJobId);
      return existing
        ? { outcome: "sleep", reason: "locked", resumeAt: now + 5_000, ...safeProgress(existing) }
        : { outcome: "stop", reason: "missing_state" };
    }

    try {
      const decision = planGmailScalableWorkflowStep(claimed, mode, now);
      if (decision.outcome === "stop") {
        await this.aggregateWriter.sync(claimed);
        if (
          claimed.view.status === "expired" ||
          (claimed.view.status === "failed" && exactVerifiedMovedLedgerCount(claimed) === 0) ||
          (decision.reason === "complete" && !claimed.view.undoAvailable)
        ) {
          await this.store.delete(claimed.userId, claimed.view.id);
        }
        return { outcome: "stop", reason: decision.reason, ...safeProgress(claimed) };
      }
      if (decision.outcome === "sleep") {
        return { outcome: "sleep", resumeAt: decision.resumeAt, ...safeProgress(claimed) };
      }

      let operationJob = claimed;
      if (decision.operation === "dispatch_trash" || decision.operation === "dispatch_undo") {
        const marked = markGmailScalableMutationDispatch(claimed, decision.operation);
        if (!marked) return { outcome: "continue", operation: decision.operation, ...safeProgress(claimed) };
        const committed = await this.store.compareAndSet(
          claimed.userId,
          claimed.view.id,
          claimed.version,
          () => marked,
          new Date(now),
          lockOwner
        );
        if (!committed) return { outcome: "sleep", reason: "locked", resumeAt: now + 5_000, ...safeProgress(claimed) };
        operationJob = committed;
      }

      const lockRefreshed = await this.store.refreshLock(
        cleanupJobId,
        lockOwner,
        new Date(this.now())
      );
      if (!lockRefreshed) {
        return { outcome: "sleep", reason: "locked", resumeAt: this.now() + 5_000, ...safeProgress(operationJob) };
      }

      const executed = await this.executor.execute({ job: operationJob, operation: decision.operation });
      const completedAt = this.now();
      executed.view.expiresAt = cleanupStateExpiryFor({
        now: completedAt,
        undoAvailable: executed.view.undoAvailable,
        terminal: ["failed", "partial", "uncertain", "undo_complete", "expired"].includes(executed.view.status)
      });
      const committed = await this.store.compareAndSet(
        operationJob.userId,
        operationJob.view.id,
        operationJob.version,
        () => executed,
        new Date(completedAt),
        lockOwner
      );
      if (!committed) return { outcome: "sleep", reason: "locked", resumeAt: now + 5_000, ...safeProgress(operationJob) };
      await this.aggregateWriter.sync(committed);
      if (committed.view.status === "undo_complete" || committed.view.status === "expired") {
        await this.store.delete(committed.userId, committed.view.id);
        return { outcome: "stop", reason: "complete", ...safeProgress(committed) };
      }
      return { outcome: "continue", operation: decision.operation, ...safeProgress(committed) };
    } finally {
      await this.store.releaseLock(cleanupJobId, lockOwner);
    }
  }
}

export function createGmailScalableWorkflowCoordinator() {
  return new GmailScalableWorkflowCoordinator(
    createPrismaGmailScalableCleanupStore(),
    new GmailScalableProviderWorkflowExecutor(),
    Date.now,
    randomUUID,
    new PrismaGmailScalableAggregateJobWriter()
  );
}

class PrismaGmailScalableAggregateJobWriter implements GmailScalableAggregateJobWriter {
  async sync(job: GmailScalableStoredJob) {
    const status = aggregateStatus(job.view.status);
    const serialized = serializeGmailScalableJob(job);
    const terminalSnapshot = createGmailScalableTerminalSnapshot(
      serialized,
      formatGmailScalableDevelopmentSummary(serialized)
    );
    await prisma.cleanupJob.updateMany({
      where: { id: job.view.id },
      data: {
        status,
        startedAt: status === "running" ? new Date(job.view.createdAt) : undefined,
        completedAt: ["completed", "failed", "cancelled", "partial"].includes(status)
          ? new Date(job.view.completedAt ?? job.view.updatedAt)
          : undefined,
        failureCode: status === "failed" ? "SCALABLE_CLEANUP_FAILED" : undefined,
        failureMessage: status === "failed" ? "Scalable cleanup stopped safely." : undefined,
        terminalState: terminalSnapshot?.status,
        terminalSnapshot: terminalSnapshot as Prisma.InputJsonValue | undefined,
        terminalSnapshotVersion: terminalSnapshot ? { increment: 1 } : undefined
      }
    });
  }

  async markMissingState(jobId: string) {
    await prisma.cleanupJob.updateMany({
      where: { id: jobId, status: { in: ["pending", "running"] } },
      data: {
        status: "cancelled",
        completedAt: new Date(),
        failureCode: "SCALABLE_STATE_UNAVAILABLE",
        failureMessage: "Scalable cleanup state expired or became unavailable."
      }
    });
  }
}

function aggregateStatus(status: GmailScalableStoredJob["view"]["status"]) {
  if (["created", "ready"].includes(status)) return "pending" as const;
  if (["complete", "undo_complete"].includes(status)) return "completed" as const;
  if (["partial", "uncertain"].includes(status)) return "partial" as const;
  if (status === "failed") return "failed" as const;
  if (status === "expired") return "cancelled" as const;
  return "running" as const;
}

function safeProgress(job: GmailScalableStoredJob) {
  return {
    status: job.view.status,
    chunksComplete: job.view.chunks.filter((chunk) => chunk.status === "complete" || chunk.status === "undo_complete").length,
    chunksTotal: job.view.chunkCount,
    verifiedCount: job.view.verifiedCount,
    verifiedRestoredCount: job.view.verifiedRestoredCount
  };
}
