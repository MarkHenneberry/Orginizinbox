import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCleanupRequestFence, createScanRequestFence, stoppedProviderWork } from "@/lib/server/provider-work-fence";
import { createProviderRequestCoordinator } from "@/lib/server/provider-request-coordinator";
import { GmailScalableCleanupProvider } from "@/lib/providers/gmail/scalable-cleanup-provider";
import { createProgress, DurableLiveScanStore, MemoryScanStateRepository, nextExpiry, setLiveScan, PrismaScanStateRepository } from "@/lib/server/live-scan-store";
import type { PrismaClient } from "@prisma/client";

const db = vi.hoisted(() => ({
  scanState: { updateMany: vi.fn(), findUnique: vi.fn() },
  cleanupJobState: { count: vi.fn() },
  providerRequestLease: { upsert: vi.fn(), updateMany: vi.fn() }
}));
vi.mock("@/lib/server/db", () => ({ prisma: db }));
vi.mock("@/lib/server/crypto", async (original) => ({
  ...await original<typeof import("@/lib/server/crypto")>(),
  encryptCleanupState: (value: string) => Buffer.from(value).toString("base64url"),
  decryptCleanupState: (value: string) => Buffer.from(value, "base64url").toString("utf8")
}));
beforeEach(() => {
  vi.clearAllMocks();
  db.scanState.updateMany.mockResolvedValue({ count: 1 });
  db.cleanupJobState.count.mockResolvedValue(1);
  db.providerRequestLease.upsert.mockResolvedValue({});
  db.providerRequestLease.updateMany.mockResolvedValue({ count: 1 });
});

describe("durable scan fencing", () => {
  it.each(["cancelled", "disconnected", "deleted", "replaced", "lease_expired", "ownership_lost"])(
    "post-claim authorization denies provider access when durable predicate fails: %s", async () => {
      db.scanState.updateMany.mockResolvedValue({ count: 0 });
      const request = vi.fn();
      const coordinate = createProviderRequestCoordinator("connection", {
        fenceAfterClaimOnly: true, beforeRequest: createScanRequestFence("scan", "owner")
      });
      await expect(coordinate(request)).rejects.toMatchObject({ name: "AbortError" });
      expect(request).not.toHaveBeenCalled();
      expect(db.scanState.updateMany).toHaveBeenCalledOnce();
      expect(db.providerRequestLease.updateMany).toHaveBeenCalledTimes(2);
      expect(db.providerRequestLease.updateMany.mock.calls[1][0].data).toEqual({ leaseOwner: null, leaseExpiresAt: null });
    }
  );

  it("does not reuse authorization for a later page or retry", async () => {
    const coordinate = createProviderRequestCoordinator("connection", {
      fenceAfterClaimOnly: true, beforeRequest: createScanRequestFence("scan", "owner")
    });
    const request = vi.fn();
    await coordinate(request);
    db.scanState.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(coordinate(request)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("checks cancellation while waiting for shared request capacity", async () => {
    db.providerRequestLease.updateMany.mockResolvedValue({ count: 0 });
    db.scanState.updateMany.mockResolvedValue({ count: 0 });
    const request = vi.fn();
    const sleep = vi.fn();
    const coordinate = createProviderRequestCoordinator("connection", {
      fenceAfterClaimOnly: true, beforeRequest: createScanRequestFence("scan", "owner"), sleep
    });
    await expect(coordinate(request)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails closed on post-claim database errors and still releases capacity", async () => {
    db.scanState.updateMany.mockRejectedValueOnce(new Error("storage unavailable"));
    const request = vi.fn();
    const coordinate = createProviderRequestCoordinator("connection", {
      fenceAfterClaimOnly: true, beforeRequest: createScanRequestFence("scan", "owner")
    });
    await expect(coordinate(request)).rejects.toThrow("storage unavailable");
    expect(request).not.toHaveBeenCalled();
    expect(db.providerRequestLease.updateMany).toHaveBeenCalledTimes(2);
  });

  it("reduces 100 uncontended requests from 400 to 300 coordination writes in a synthetic latency model", async () => {
    for (const optimized of [false, true]) {
      let dbMs = 0;
      let providerMs = 0;
      const update = vi.fn(async () => { dbMs += 250; return { count: 1 }; });
      const coordinate = createProviderRequestCoordinator("connection", {
        fenceAfterClaimOnly: optimized,
        client: { providerRequestLease: { upsert: vi.fn(), updateMany: update } } as never,
        beforeRequest: async () => { dbMs += 250; }
      });
      for (let page = 0; page < 100; page++) await coordinate(async () => { providerMs += 1000; });
      expect(update).toHaveBeenCalledTimes(200);
      expect(dbMs).toBe(optimized ? 75_000 : 100_000);
      expect(dbMs + providerMs).toBe(optimized ? 175_000 : 200_000);
    }
  });

  it("checks exact ownership, status, connection and expiry while renewing only a live lease", async () => {
    await createScanRequestFence("scan-a", "worker-a")();
    expect(db.scanState.updateMany).toHaveBeenCalledWith({
      where: {
        scanId: "scan-a", lockOwner: "worker-a", status: "running",
        expiresAt: { gt: expect.any(Date) }, lockExpiresAt: { gt: expect.any(Date) },
        scan: { status: "running" }, providerConnection: { disconnectedAt: null, encryptedAccessToken: { not: null } }
      }, data: { lockExpiresAt: expect.any(Date) }
    });
    db.scanState.updateMany.mockResolvedValue({ count: 0 });
    await expect(createScanRequestFence("scan-a", "worker-a")()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops on unavailable durable storage rather than proceeding with cached authorization", async () => {
    db.scanState.updateMany.mockRejectedValueOnce(new Error("database unavailable"));
    const request = vi.fn();
    const coordinate = createProviderRequestCoordinator("connection", { beforeRequest: createScanRequestFence("scan", "owner") });
    await expect(coordinate(request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "deleted", "replaced", "lease_expired", "ownership_lost"])(
    "does not let a stale process overwrite %s scan state", async (reason) => {
      const repository = new MemoryScanStateRepository();
      const store = new DurableLiveScanStore(repository);
      const session = { progress: createProgress({ scanId: "scan", provider: "gmail", limit: "full", batchSize: 250 }), expiresAt: nextExpiry() };
      await store.accept({ userId: "user", providerConnectionId: "connection", session });
      await store.claim("scan", "old-worker");
      if (reason === "cancelled") await store.update("user", "gmail", (current) => { current.progress.status = "cancelled"; });
      if (reason === "deleted" || reason === "replaced") await store.delete("user", "gmail");
      if (reason === "replaced") await store.accept({ userId: "user", providerConnectionId: "connection", session: {
        ...session, progress: { ...session.progress, scanId: "replacement" }
      } });
      if (reason === "lease_expired" || reason === "ownership_lost") {
        await repository.release("scan", "old-worker");
        await repository.claim({ scanId: "scan", owner: reason === "ownership_lost" ? "new-worker" : "old-worker",
          now: new Date(), lockExpiresAt: new Date(Date.now() + (reason === "ownership_lost" ? 60_000 : -1)) });
      }
      const replacementProcess = new DurableLiveScanStore(repository);
      expect(await replacementProcess.set("user", session, "gmail", "old-worker")).toBeUndefined();
      if (reason === "cancelled") expect((await store.get("user", "gmail"))?.progress.status).toBe("cancelled");
      if (reason === "replaced") expect((await store.get("user", "gmail"))?.progress.scanId).toBe("replacement");
    }
  );

  it("turns a rejected worker progress write into cancellation rather than silently returning undefined", async () => {
    db.scanState.findUnique.mockResolvedValue(null);
    await expect(setLiveScan("user", {
      progress: createProgress({ scanId: "deleted", limit: "full", batchSize: 250 }), expiresAt: nextExpiry()
    }, "gmail", "worker")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("enforces the fence atomically in the Prisma progress-write predicate", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const aggregateWrite = vi.fn();
    const client = { $transaction: (callback: (value: unknown) => unknown) => callback({ scanState: { updateMany }, scan: { update: aggregateWrite } }) };
    const repository = new PrismaScanStateRepository(client as unknown as PrismaClient);
    expect(await repository.replace({ userId: "user", provider: "gmail", scanId: "scan", expectedVersion: 3,
      encryptedPayload: "ciphertext", status: "completed", expiresAt: new Date(), lockOwner: "worker" })).toBe(false);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      version: 3, lockOwner: "worker", status: "running", scan: { status: "running" },
      lockExpiresAt: { gt: expect.any(Date) }, providerConnection: { disconnectedAt: null }
    });
    expect(aggregateWrite).not.toHaveBeenCalled();
  });
});

describe("disconnect at provider boundaries", () => {
  it("rechecks after waiting for a Graph slot and releases the slot without sending a request", async () => {
    const fence = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(stoppedProviderWork());
    const coordinate = createProviderRequestCoordinator("connection", { beforeRequest: fence });
    const request = vi.fn();
    await expect(coordinate(request)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
    expect(db.providerRequestLease.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { leaseOwner: null, leaseExpiresAt: null }
    }));
  });

  it("binds cleanup requests to the original connection generation, exact job and lease", async () => {
    const fence = createCleanupRequestFence({ id: "connection", userId: "owner", provider: "microsoft", sessionGeneration: "generation" }, "job", "worker", 7);
    await fence();
    expect(db.cleanupJobState.count.mock.calls[0][0].where).toMatchObject({
      jobId: "job", userId: "owner", lockOwner: "worker", version: 7,
      job: { status: { not: "cancelled" }, scan: { providerConnectionId: "connection", provider: "microsoft",
        providerConnection: { disconnectedAt: null, sessionGeneration: "generation" } } }
    });
    db.cleanupJobState.count.mockResolvedValueOnce(0);
    await expect(fence()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not send Gmail mutation after a failed fence and never retries that rejection", async () => {
    const beforeRequest = vi.fn().mockRejectedValue(stoppedProviderWork());
    const fetchImpl = vi.fn();
    const provider = new GmailScalableCleanupProvider("fixture-token", "fixture@example.test", { beforeRequest, fetchImpl });
    await expect(provider.moveToTrash(["fixture-id"], vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(beforeRequest).toHaveBeenCalledTimes(1);
  });

  it("stops between Gmail read-only retry attempts after disconnect", async () => {
    const beforeRequest = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(stoppedProviderWork());
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const provider = new GmailScalableCleanupProvider("fixture-token", "fixture@example.test", {
      beforeRequest, fetchImpl, sleepImpl: async () => undefined
    });
    await expect(provider.captureHistoryCheckpoint(vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
