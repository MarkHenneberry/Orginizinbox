import { z } from "zod";
import {
  gmailScalableJobStatuses,
  type GmailScalableJobView
} from "@/lib/domain/gmail-scalable-cleanup";

const terminalStatuses = ["complete", "partial", "uncertain", "failed", "undo_complete"] as const;

const terminalSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(terminalStatuses),
  requestedCount: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
  chunksComplete: z.number().int().nonnegative(),
  safeCount: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  attemptedCount: z.number().int().nonnegative(),
  verifiedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  uncertainCount: z.number().int().nonnegative(),
  verifiedRestoredCount: z.number().int().nonnegative(),
  failedRestoreCount: z.number().int().nonnegative(),
  uncertainRestoreCount: z.number().int().nonnegative(),
  quotaConsumedUnits: z.number().int().nonnegative(),
  developmentAuditQuotaUnits: z.number().int().nonnegative(),
  quotaWorkingLimit: z.number().int().nonnegative(),
  restoreMode: z.enum(["undo", "recovery"]).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative(),
  terminalDiagnostic: z.string().max(100_000)
}).strict();

export type GmailScalableTerminalSnapshot = z.infer<typeof terminalSnapshotSchema>;

export function createGmailScalableTerminalSnapshot(
  job: GmailScalableJobView,
  terminalDiagnostic: string
): GmailScalableTerminalSnapshot | undefined {
  if (!terminalStatuses.includes(job.status as (typeof terminalStatuses)[number]) || !job.completedAt) return undefined;
  const chunksComplete = job.chunksComplete ?? job.chunks.filter((chunk) =>
    chunk.status === "complete" || chunk.status === "undo_complete"
  ).length;
  return terminalSnapshotSchema.parse({
    schemaVersion: 1,
    status: job.status,
    requestedCount: job.requestedCount,
    chunkSize: job.chunkSize,
    chunkCount: job.chunkCount,
    chunksComplete,
    safeCount: job.safeCount,
    excludedCount: job.excludedCount,
    attemptedCount: job.attemptedCount,
    verifiedCount: job.verifiedCount,
    failedCount: job.failedCount,
    uncertainCount: job.uncertainCount,
    verifiedRestoredCount: job.verifiedRestoredCount,
    failedRestoreCount: job.failedRestoreCount,
    uncertainRestoreCount: job.uncertainRestoreCount,
    quotaConsumedUnits: job.quotaConsumedUnits,
    developmentAuditQuotaUnits: job.developmentAuditQuotaUnits,
    quotaWorkingLimit: job.quotaWorkingLimit,
    restoreMode: job.restoreMode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    terminalDiagnostic
  });
}

export function parseGmailScalableTerminalSnapshot(value: unknown) {
  const parsed = terminalSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function terminalSnapshotToGmailScalableJobView(input: {
  id: string;
  snapshot: GmailScalableTerminalSnapshot;
  snapshotVersion: number;
}): GmailScalableJobView {
  const snapshot = input.snapshot;
  if (!gmailScalableJobStatuses.includes(snapshot.status)) throw new Error("Invalid scalable terminal status.");
  return {
    id: input.id,
    status: snapshot.status,
    requestedCount: snapshot.requestedCount,
    chunkSize: snapshot.chunkSize,
    chunkCount: snapshot.chunkCount,
    chunksComplete: snapshot.chunksComplete,
    safeCount: snapshot.safeCount,
    excludedCount: snapshot.excludedCount,
    attemptedCount: snapshot.attemptedCount,
    verifiedCount: snapshot.verifiedCount,
    failedCount: snapshot.failedCount,
    uncertainCount: snapshot.uncertainCount,
    verifiedRestoredCount: snapshot.verifiedRestoredCount,
    failedRestoreCount: snapshot.failedRestoreCount,
    uncertainRestoreCount: snapshot.uncertainRestoreCount,
    verifiedProcessedCount: snapshot.verifiedCount,
    progressLabel: snapshot.status === "undo_complete"
      ? `${snapshot.verifiedRestoredCount.toLocaleString("en-US")} messages restored.`
      : `${snapshot.verifiedCount.toLocaleString("en-US")} messages moved to Trash.`,
    quotaConsumedUnits: snapshot.quotaConsumedUnits,
    developmentAuditQuotaUnits: snapshot.developmentAuditQuotaUnits,
    quotaWorkingLimit: snapshot.quotaWorkingLimit,
    suggestedDeltas: [],
    groupIndices: [],
    chunks: [],
    undoAvailable: false,
    restoreMode: snapshot.restoreMode,
    duplicateStartCount: 0,
    duplicateDispatchCount: 0,
    duplicateUndoCount: 0,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    expiresAt: snapshot.completedAt,
    completedAt: snapshot.completedAt,
    terminalDiagnostic: snapshot.terminalDiagnostic,
    terminalSnapshotVersion: input.snapshotVersion
  };
}
