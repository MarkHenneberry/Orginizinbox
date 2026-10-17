import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/db";
import { createCleanupJobStateCodec } from "@/lib/server/cleanup-job-store";
import { isOutlookPreMutationJob, type OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";
import { retrySerializableTransaction } from "@/lib/server/retry-serializable-transaction";

export async function discardUnconfirmedOutlookCleanup(userId: string, providerConnectionId: string, jobId: string) {
  return retrySerializableTransaction(() => prisma.$transaction(async tx => {
    const now = new Date();
    const row = await tx.cleanupJobState.findFirst({ where: {
      jobId, userId, expiresAt: { gt: now },
      job: { status: { not: "cancelled" }, scan: { userId, provider: "microsoft", providerConnectionId } }
    }, include: { job: { select: { scanId: true } } } });
    if (!row) return false;
    const job = createCleanupJobStateCodec<OutlookCleanupStoredJob>().decode(row.encryptedPayload);
    if (job.userId !== userId || job.view.id !== jobId || job.version !== row.version || job.provider !== "microsoft" ||
        job.payload.providerConnectionId !== providerConnectionId || job.payload.scanId !== row.job.scanId || !isOutlookPreMutationJob(job)) return false;
    const accounting = await tx.creditJobAccounting.findUnique({ where: { jobId } });
    if (accounting && (accounting.moved !== 0 || accounting.restored !== 0)) return false;
    // A live preparation lease permits reads only. Deletion fences its next request/write;
    // the version predicate serializes cancellation against confirmation and checkpoints.
    const removed = await tx.cleanupJobState.deleteMany({ where: { jobId, userId, version: row.version } });
    if (removed.count !== 1) return false;
    await tx.cleanupJob.update({ where: { id: jobId }, data: {
      status: "cancelled", acceptanceKey: null, completedAt: now,
      terminalState: null, terminalSnapshot: Prisma.DbNull, terminalSnapshotVersion: 0
    } });
    // CreditJobAccounting.activeStateJobId is set null by the existing FK, with no credit entry.
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
