import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { PrismaCleanupJobStore, PrismaCleanupJobStateRepository, createCleanupJobStateCodec, prepareCleanupJobState, createPreparedCleanupJobState } from "@/lib/server/cleanup-job-store";
import type { CleanupJobStateRow } from "@/lib/server/cleanup-job-store";
import type { OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";
import { createEmptyOutlookCleanupTiming } from "@/lib/domain/outlook-cleanup";
import { cleanupChunkBytes, cleanupChunkReadPage, cleanupInlineBytes, isChunkedCleanupState } from "@/lib/server/outlook-state-chunks";
import { billingFixture } from "./fixtures/credit-billing";
import { creditSnapshot } from "@/lib/billing/credits";
import { getOutlookCleanupLedgers } from "@/lib/server/outlook-cleanup-store";

vi.mock("@/lib/config", () => ({ env: { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"), CLEANUP_STATE_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString("base64") },
  runtimeConfig: { cleanupStateLockTtlSeconds: 600 } }));
const codec = createCleanupJobStateCodec<OutlookCleanupStoredJob>();
function largeJob(count = 10000): OutlookCleanupStoredJob & { creditBilling: true } {
  const id = (i: number) => `opaque-${createHash("sha256").update(String(i)).digest("hex")}`.padEnd(160, "x");
  return { provider: "microsoft", creditBilling: true, userId: "owner", acceptanceKey: "accept", version: 1,
    view: { provider: "microsoft", id: "job", status: "ready", requested: count, approved: count, excludedBySafety: 0,
      movedVerified: 0, restoredVerified: 0, failed: 0, uncertain: 0, checked: 0, chunksCompleted: 0, totalChunks: Math.ceil(count / 100),
      batchesCompleted: 0, totalBatches: Math.ceil(count / 20), currentChunk: 0, currentBatch: 0, effectiveBatchSize: 20,
      undoBatchesCompleted: 0, undoTotalBatches: 0, graphRequests: 0, httpRoundTrips: 0, graphSubrequests: 0, retries: 0,
      httpRoundTripsByPhase: createEmptyOutlookCleanupTiming(), timingMs: createEmptyOutlookCleanupTiming(), groupIndices: [0],
      undoAvailable: false, undoStatus: "not_available", createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 1800000 },
    payload: { scanId: "scan", providerConnectionId: "connection", selectedSenders: [{ groupIndex: 0, senderKey: "private@example.test" }],
      participatedConversationIds: [], verificationCandidates: Array.from({ length: count }, (_, i) => ({ messageId: id(i), groupIndex: 0 })),
      targets: Array.from({ length: count }, (_, i) => ({ originalMessageId: id(i), groupIndex: 0, state: "frozen" })) }
  };
}

type Where = { jobId?: string; userId?: string; version?: number; lockOwner?: string; lockExpiresAt?: { gt: Date }; expiresAt?: { gt?: Date; lte?: Date }; OR?: unknown };
function fixture() {
  let row: CleanupJobStateRow | null = null;
  const chunks = new Map<string, { jobId: string; slot: string; encryptedPayload: string }>();
  const billing = billingFixture(20000);
  const reads: number[] = [], writes: string[] = [], isolation: string[] = [];
  let failWrite = false;
  const matches = (where: Where) => Boolean(row && (!where.jobId || where.jobId === row.jobId) && (!where.userId || where.userId === row.userId) &&
    (where.version === undefined || where.version === row.version) && (!where.lockOwner || where.lockOwner === row.lockOwner) &&
    (!where.lockExpiresAt || (row.lockExpiresAt && row.lockExpiresAt > where.lockExpiresAt.gt)) &&
    (!where.expiresAt?.gt || row.expiresAt > where.expiresAt.gt) && (!where.expiresAt?.lte || row.expiresAt <= where.expiresAt.lte));
  const state = {
    create: vi.fn(async ({ data }: { data: CleanupJobStateRow }) => { row = { ...data, createdAt: new Date(), updatedAt: new Date() }; return structuredClone(row); }),
    findUnique: vi.fn(async () => {
      if (row) expect(Buffer.byteLength(row.encryptedPayload)).toBeLessThanOrEqual(cleanupInlineBytes);
      return structuredClone(row);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      if (!matches(where)) return { count: 0 };
      if (where.OR && row?.lockOwner && row.lockExpiresAt && row.lockExpiresAt > new Date()) return { count: 0 };
      for (const [key, value] of Object.entries(data)) Reflect.set(row!, key, key === "version" ? row!.version + 1 : value);
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      if (!matches(where)) return { count: 0 };
      if (where.OR && row?.lockExpiresAt && row.lockExpiresAt > new Date()) return { count: 0 };
      row = null; chunks.clear();
      for (const value of billing.jobs.values()) value.activeStateJobId = null;
      return { count: 1 };
    })
  };
  const child = {
    createMany: vi.fn(async ({ data }: { data: Array<{ jobId: string; slot: string; encryptedPayload: string }> }) => {
      expect(data.length).toBeLessThanOrEqual(8);
      for (const row of data) { writes.push(row.slot); chunks.set(row.slot, structuredClone(row)); }
      return { count: data.length };
    }),
    findMany: vi.fn(async ({ where }: { where: { jobId: string; slot: { in: string[] } } }) => {
      expect(where.slot.in.length).toBeLessThanOrEqual(cleanupChunkReadPage);
      const result = [...chunks.values()].filter(c => c.jobId === where.jobId && where.slot.in.includes(c.slot));
      const bytes = Buffer.byteLength(JSON.stringify(result)); reads.push(bytes);
      expect(bytes).toBeLessThan(3 * 1024 * 1024);
      return structuredClone(result);
    }),
    upsert: vi.fn(async ({ create }: { create: { jobId: string; slot: string; encryptedPayload: string } }) => {
      if (failWrite) throw new Error("simulated storage failure");
      expect(Buffer.byteLength(create.encryptedPayload)).toBeLessThanOrEqual(cleanupChunkBytes);
      writes.push(create.slot); chunks.set(create.slot, structuredClone(create)); return create;
    }),
    deleteMany: vi.fn(async ({ where }: { where: { slot: { in: string[] } } }) => { for (const slot of where.slot.in) chunks.delete(slot); return { count: where.slot.in.length }; })
  };
  const db = { ...billing.db, cleanupJobState: state, cleanupJobStateChunk: child,
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>, options: { isolationLevel: string } = { isolationLevel: "Serializable" }) => {
      isolation.push(options.isolationLevel);
      const before = structuredClone({ row, chunks });
      try { return await billing.db.$transaction(async () => run(db)); }
      catch (error) { row = before.row; chunks.clear(); before.chunks.forEach((v, k) => chunks.set(k, v)); throw error; }
    })
  };
  const client = db as unknown as PrismaClient;
  const store = () => new PrismaCleanupJobStore<OutlookCleanupStoredJob>(new PrismaCleanupJobStateRepository(client));
  return { client, db, store, chunks, billing, reads, writes, isolation, get row() { return row!; }, failNextWrite: () => { failWrite = true; } };
}
beforeEach(() => vi.restoreAllMocks());

it("keeps small jobs inline with no chunk queries, writes or schema-dependent reads", async () => {
  const f = fixture(), store = f.store();
  await store.create(largeJob(5));
  expect(isChunkedCleanupState(codec.decode(f.row.encryptedPayload))).toBe(false);
  expect((await store.get("owner", "job"))?.payload.targets).toHaveLength(5);
  expect(f.db.cleanupJobStateChunk.findMany).not.toHaveBeenCalled();
  expect(f.chunks.size).toBe(0);
});

it("loads 10k exact targets in bounded snapshot pages; updates only changed chunks and reuses invocation-local verified content", async () => {
  const f = fixture(); await f.store().create(largeJob());
  const chunkCount = f.chunks.size;
  expect(chunkCount).toBeGreaterThan(100); expect(chunkCount).toBeLessThan(400);
  expect(isChunkedCleanupState(codec.decode(f.row.encryptedPayload))).toBe(true);
  expect(JSON.stringify([...f.chunks.values()])).not.toMatch(/opaque-|private@/);
  const store = f.store();
  const loaded = await store.get("owner", "job");
  expect(loaded?.payload.targets).toEqual(largeJob().payload.targets);
  expect(f.isolation).toContain("RepeatableRead");
  const readCount = f.reads.length, writeCount = f.writes.length;
  const confirmed = await store.compareAndSet("owner", "job", loaded!.version, job => {
    job.payload.confirmedAt = Date.now(); job.view.status = "running"; return job;
  });
  expect(f.writes).toHaveLength(writeCount); // Header/confirmation only, unchanged target pages.
  expect(await creditSnapshot(f.billing.client, "owner")).toMatchObject({ balance: 20000, reserved: 10000 });
  const moved = await store.compareAndSet("owner", "job", confirmed!.version, job => {
    for (const target of job.payload.targets.slice(0, 20)) Object.assign(target, { state: "moved_verified", movedMessageId: `moved-${target.originalMessageId}`, originalFolderId: "exact-original-folder" });
    return job;
  });
  expect(f.writes.length - writeCount).toBeLessThanOrEqual(4);
  expect(f.reads).toHaveLength(readCount);
  expect(f.billing.row.creditBalance).toBe(19980);
  const afterWrite = f.writes.length;
  expect(await store.compareAndSet("owner", "job", confirmed!.version, job => job)).toBeUndefined();
  expect(f.writes).toHaveLength(afterWrite); expect(f.billing.row.creditBalance).toBe(19980);
  const replacement = f.store();
  const resumed = await replacement.get("owner", "job");
  expect(resumed?.payload.targets).toEqual(moved!.payload.targets);
  expect(f.reads.length).toBeGreaterThan(readCount);
  const restored = await replacement.compareAndSet("owner", "job", resumed!.version, job => {
    job.view.status = "undoing";
    for (const target of job.payload.targets.slice(0, 20)) Object.assign(target, { state: "restored_verified", restoredMessageId: `restored-${target.movedMessageId}` });
    return job;
  });
  expect(restored?.payload.targets[0].originalFolderId).toBe("exact-original-folder");
  expect(f.billing.row.creditBalance).toBe(19980); // Undo never refunds.
}, 30000);

it.each(["missing", "corrupt", "swapped"])("fails closed for %s chunks without exposing their contents", async fault => {
  const f = fixture(); await f.store().create(largeJob());
  const values = [...f.chunks.values()], first = values[0];
  if (fault === "missing") f.chunks.delete(first.slot);
  if (fault === "corrupt") first.encryptedPayload = "invalid";
  if (fault === "swapped") first.encryptedPayload = values[1].encryptedPayload;
  await expect(f.store().get("owner", "job")).rejects.toThrow("could not be authenticated");
});

it.each(["jobId", "userId"])("rejects authenticated chunk content bound to another %s", async field => {
  const f = fixture(); await f.store().create(largeJob());
  const row = [...f.chunks.values()][0];
  const content = codec.decode(row.encryptedPayload) as unknown as Record<string, unknown>;
  content[field] = field === "jobId" ? "bad" : "other";
  row.encryptedPayload = codec.encode(content as unknown as OutlookCleanupStoredJob);
  await expect(f.store().get("owner", "job")).rejects.toThrow("could not be authenticated");
});

it("rolls back parent, chunks and credits together on storage failure; stale owners cannot write", async () => {
  const f = fixture(), store = f.store(); await store.create(largeJob());
  await store.claim("job", "worker");
  const confirmed = await store.compareAndSet("owner", "job", 1, job => { job.payload.confirmedAt = Date.now(); return job; }, new Date(), "worker");
  const before = structuredClone({ row: f.row, chunks: [...f.chunks] });
  f.failNextWrite();
  await expect(store.compareAndSet("owner", "job", confirmed!.version, job => {
    Object.assign(job.payload.targets[0], { state: "moved_verified", movedMessageId: "exact-returned-id", originalFolderId: "original-folder" }); return job;
  }, new Date(), "worker")).rejects.toThrow("simulated storage failure");
  expect({ row: f.row, chunks: [...f.chunks] }).toEqual(before);
  expect(f.billing.row.creditBalance).toBe(20000);
  expect(await store.compareAndSet("owner", "job", confirmed!.version, job => job, new Date(), "stale-worker")).toBeUndefined();
});

it("cascades chunks on scoped deletion and releases reservations without changing spent credits", async () => {
  const f = fixture(), store = f.store(); await store.create(largeJob());
  await store.compareAndSet("owner", "job", 1, job => { job.payload.confirmedAt = Date.now(); return job; });
  expect((await creditSnapshot(f.billing.client, "owner")).reserved).toBe(10000);
  expect(await store.delete("another-user", "job")).toBe(false); expect(f.chunks.size).toBeGreaterThan(0);
  expect(await store.delete("owner", "job")).toBe(true); expect(f.chunks.size).toBe(0);
  expect((await creditSnapshot(f.billing.client, "owner")).reserved).toBe(0);
  expect(f.billing.row.creditBalance).toBe(20000);
});

it("creates a chunked accepted job inside its existing transaction, with a bounded parent response", async () => {
  const f = fixture();
  const prepared = prepareCleanupJobState(largeJob());
  expect(prepared.chunkWrite?.rows.length).toBeGreaterThan(0);
  await f.client.$transaction(tx => createPreparedCleanupJobState(tx, prepared));
  expect((await f.store().get("owner", "job"))?.payload.targets).toHaveLength(10000);
});

it("preserves 10k exact moved/restored/deletion ledgers across replacements without a large DB response", async () => {
  const f = fixture(), store = f.store();
  const job = largeJob();
  const folder = "folder-".padEnd(160, "f");
  for (const target of job.payload.targets) Object.assign(target, {
    state: "moved_verified", movedMessageId: `moved-${target.originalMessageId}`, originalFolderId: folder
  });
  await store.create(job);
  const movedChunks = f.chunks.size;
  const recovered = await f.store().get("owner", "job");
  expect(getOutlookCleanupLedgers(recovered!).verifiedMoved.map(t => [t.movedMessageId, t.originalFolderId])).toEqual(job.payload.targets.map(t => [t.movedMessageId, folder]));
  const restored = await store.compareAndSet("owner", "job", 1, value => {
    for (const target of value.payload.targets) Object.assign(target, { state: "restored_verified", restoredMessageId: `restored-${target.movedMessageId}` });
    value.permanentDeletion = { status: "complete", targets: value.payload.targets.map((target, index) => ({
      key: String(index), messageId: target.movedMessageId!, folderId: folder, state: index === 0 ? "uncertain" : "verified_deleted" })) };
    return value;
  });
  const complete = await f.store().get("owner", "job");
  expect(complete?.payload.targets).toEqual(restored!.payload.targets);
  expect(complete?.permanentDeletion).toEqual(restored!.permanentDeletion);
  const bytes = [...f.chunks.values()].map(c => Buffer.byteLength(c.encryptedPayload));
  process.stdout.write(`Chunked Outlook 10k synthetic recovery: ${JSON.stringify({ movedChunks, fullRecoveryDeletionChunks: f.chunks.size,
    chunkBytesMax: Math.max(...bytes), encryptedChildBytes: bytes.reduce((a, b) => a + b, 0), parentBytes: Buffer.byteLength(f.row.encryptedPayload),
    responseBytesMax: Math.max(...f.reads), legacyEncryptedBytes: Buffer.byteLength(codec.encode(complete!)) })}\n`);
}, 30000);

it("migrates an inline job atomically on growth, then rejects an old authenticated chunk revision", async () => {
  const f = fixture(), store = f.store(); await store.create(largeJob(5));
  const grown = await store.compareAndSet("owner", "job", 1, value => ({ ...largeJob(), version: value.version }));
  expect(grown?.payload.targets).toHaveLength(10000); expect(f.chunks.size).toBeGreaterThan(0);
  const old = new Map([...f.chunks].map(([slot, value]) => [slot, structuredClone(value)]));
  await store.compareAndSet("owner", "job", grown!.version, value => { value.payload.targets[0].originalFolderId = "changed-folder"; return value; });
  const changed = [...f.chunks].find(([slot, value]) => old.get(slot)?.encryptedPayload !== value.encryptedPayload)!;
  f.chunks.set(changed[0], old.get(changed[0])!);
  await expect(f.store().get("owner", "job")).rejects.toThrow("could not be authenticated");
});

it("preserves active locked chunks at expiry and cascades them only after ownership expires", async () => {
  const f = fixture(), store = f.store(); await store.create(largeJob());
  await store.claim("job", "worker");
  f.row.expiresAt = new Date(Date.now() - 1);
  expect(await store.get("owner", "job")).toBeUndefined(); expect(f.chunks.size).toBeGreaterThan(0);
  f.row.lockExpiresAt = new Date(Date.now() - 1);
  expect(await store.purgeExpired()).toBe(1); expect(f.chunks.size).toBe(0);
});

it("reclaims only an expired lease and rejects stale-owner writes to chunked state", async () => {
  const f = fixture(), store = f.store(); await store.create(largeJob());
  expect(await store.claim("job", "first")).toBeDefined();
  expect(await f.store().claim("job", "second")).toBeUndefined();
  f.row.lockExpiresAt = new Date(Date.now() - 1);
  expect(await f.store().claim("job", "second")).toBeDefined();
  const writes = f.writes.length;
  expect(await store.compareAndSet("owner", "job", 1, value => { value.payload.targets[0].state = "excluded"; return value; }, new Date(), "first")).toBeUndefined();
  expect(f.writes).toHaveLength(writes);
});

it("retains legacy JSON date semantics inside large sender context", async () => {
  const f = fixture(), job = largeJob();
  const date = new Date("2025-01-01T00:00:00Z");
  job.payload.senderGroups = [{ oldestMessageAt: date } as NonNullable<typeof job.payload.senderGroups>[number]];
  await f.store().create(job);
  expect((await f.store().get("owner", "job"))?.payload.senderGroups?.[0].oldestMessageAt).toBe(date.toISOString());
});

it("preserves Unicode even when a serialized page splits a surrogate pair between segments", async () => {
  const f = fixture(), job = largeJob();
  const displayName = "a" + "\ud83d\udce7".repeat(20000);
  job.payload.senderGroups = [{ displayName } as NonNullable<typeof job.payload.senderGroups>[number]];
  await f.store().create(job);
  expect((await f.store().get("owner", "job"))?.payload.senderGroups?.[0].displayName).toBe(displayName);
});
