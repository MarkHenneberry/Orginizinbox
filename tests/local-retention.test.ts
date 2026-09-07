import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalRetentionSweep } from "@/lib/server/local-retention-sweep";
import type { GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("development memory retention", () => {
  it("runs without reads, deduplicates timers, stops when empty and restarts for later work", () => {
    const sweep = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const ensure = createLocalRetentionSweep(sweep);
    ensure();
    ensure();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(120_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    ensure();
    vi.advanceTimersByTime(60_000);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it("physically sweeps legacy expired state without a read, deferring active operations", async () => {
    const store = await import("@/lib/server/gmail-cleanup-store");
    store.gmailCleanupJobs.clear();
    const job = store.createGmailCleanupJob({ userId: "test-user" } as Parameters<typeof store.createGmailCleanupJob>[0]);
    let finish!: () => void;
    const active = store.runOrJoinGmailCleanupOperation(`trash:${job.id}`, () => new Promise<void>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    vi.advanceTimersByTime(600_000);
    expect(store.gmailCleanupJobs.has(job.id)).toBe(true);
    expect(store.getGmailCleanupJob("test-user", job.id)).toBeUndefined();
    expect(store.gmailCleanupJobs.has(job.id)).toBe(true);
    finish();
    await active.promise;
    await Promise.resolve();
    vi.advanceTimersByTime(60_000);
    expect(store.gmailCleanupJobs.has(job.id)).toBe(false);
    expect(store.purgeExpiredGmailCleanupJobs()).toBe(0);
  });

  it("sweeps idle encrypted development jobs without decryption and preserves non-expired/in-flight jobs", async () => {
    const { InMemoryGmailScalableCleanupStore } = await import("@/lib/server/gmail-scalable-cleanup-store");
    const codec = { encode: vi.fn(() => "ciphertext"), decode: vi.fn() };
    const store = new InMemoryGmailScalableCleanupStore(codec);
    const make = (id: string, status: string, expiresAt: number) => ({
      userId: "fixture", acceptanceKey: id, view: { id, status, expiresAt, chunks: [] }, payload: { chunks: [] }
    }) as unknown as GmailScalableStoredJob;
    store.create(make("idle", "ready", Date.now() + 1));
    store.create(make("unexpired", "ready", Date.now() + 120_000));
    store.create(make("active", "mutating", Date.now() + 1));
    vi.advanceTimersByTime(60_000);
    const rows = (store as unknown as { jobs: Map<string, unknown> }).jobs;
    expect([...rows.keys()]).toEqual(["unexpired", "active"]);
    expect(codec.decode).not.toHaveBeenCalled();
  });
});
