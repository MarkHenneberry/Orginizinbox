import "server-only";
import type { PrismaClient } from "@prisma/client";
import { expiredUnlockedStateWhere } from "@/lib/domain/transient-retention";
import { prisma } from "@/lib/server/db";

const batchSize = 500;
const maxBatches = 10;

type SweepResult = {
  deleted: number;
  remaining: number | null;
  deferred: number | null;
  status: "success" | "failed";
};

// Read only opaque primary keys; recheck expiry/leases in each atomic DELETE.
async function sweep(input: {
  find: () => Promise<string[]>;
  remove: (ids: string[]) => Promise<number>;
  remaining: () => Promise<number>;
  deferred: () => Promise<number>;
}): Promise<SweepResult> {
  let deleted = 0;
  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const ids = await input.find();
      if (ids.length === 0) break;
      deleted += await input.remove(ids);
      if (ids.length < batchSize) break;
    }
    return { deleted, remaining: await input.remaining(), deferred: await input.deferred(), status: "success" };
  } catch {
    // Database errors can contain query parameters; never return/log the exception.
    return { deleted, remaining: null, deferred: null, status: "failed" };
  }
}

export async function purgeExpiredTransientState(
  client: Pick<PrismaClient, "scanState" | "cleanupJobState"> = prisma,
  now = new Date()
) {
  const startedAt = Date.now();
  const where = expiredUnlockedStateWhere(now);
  const deferredWhere = { expiresAt: { lte: now }, lockExpiresAt: { gt: now } };
  const scans = await sweep({
    find: async () => (await client.scanState.findMany({
      where, select: { scanId: true }, orderBy: { expiresAt: "asc" }, take: batchSize
    })).map((row) => row.scanId),
    remove: async (ids) => (await client.scanState.deleteMany({ where: { ...where, scanId: { in: ids } } })).count,
    remaining: () => client.scanState.count({ where }),
    deferred: () => client.scanState.count({ where: deferredWhere })
  });
  const cleanup = await sweep({
    find: async () => (await client.cleanupJobState.findMany({
      where, select: { jobId: true }, orderBy: { expiresAt: "asc" }, take: batchSize
    })).map((row) => row.jobId),
    remove: async (ids) => (await client.cleanupJobState.deleteMany({ where: { ...where, jobId: { in: ids } } })).count,
    remaining: () => client.cleanupJobState.count({ where }),
    deferred: () => client.cleanupJobState.count({ where: deferredWhere })
  });
  return {
    status: scans.status === "success" && cleanup.status === "success" ? "success" as const : "failed" as const,
    scans,
    cleanup,
    durationMs: Math.max(0, Date.now() - startedAt)
  };
}
