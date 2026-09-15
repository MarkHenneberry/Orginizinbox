import { afterEach, describe, expect, it, vi } from "vitest";
import { startAdaptivePolling, pollingInterval } from "@/lib/adaptive-polling";
import { createDurableWriteGate } from "@/lib/server/durable-write-gate";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("redundant durable write coalescing", () => {
  it("reduces 100 one-second page snapshots to 20 without delaying forced boundaries", async () => {
    let now = 0;
    const write = vi.fn(async () => undefined);
    const gate = createDurableWriteGate(5_000, () => now);
    for (let page = 0; page < 100; page++) {
      now += 1_000;
      await gate(write);
    }
    expect(write).toHaveBeenCalledTimes(20);
    await gate(write, true);
    expect(write).toHaveBeenCalledTimes(21);
  });

  it("propagates rejected writes and does not treat them as committed", async () => {
    const gate = createDurableWriteGate(5_000, () => 0);
    const write = vi.fn().mockRejectedValueOnce(new Error("Lost lease")).mockResolvedValue(undefined);
    await expect(gate(write)).rejects.toThrow("Lost lease");
    await expect(gate(write)).resolves.toBe(true);
    await expect(gate(write)).resolves.toBe(false);
  });

  it("coalesces only lease heartbeats, with errors still propagated when renewal is due", async () => {
    let now = 0;
    const gate = createDurableWriteGate(30_000, () => now, false);
    const heartbeat = vi.fn(async () => undefined);
    for (now = 0; now < 30_000; now += 1_000) await gate(heartbeat);
    expect(heartbeat).not.toHaveBeenCalled();
    await gate(heartbeat);
    expect(heartbeat).toHaveBeenCalledOnce();
    now += 30_000;
    await expect(gate(async () => { throw new Error("Lost lease"); })).rejects.toThrow("Lost lease");
  });
});

describe("single-flight adaptive status polling", () => {
  it("refreshes availability every 15 seconds and immediately on window focus", async () => {
    vi.useFakeTimers();
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    const poll = vi.fn(async () => true);
    const stop = startAdaptivePolling(poll, undefined, 15_000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(3);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never overlaps slow polls, including focus wake-ups, and aborts on teardown", async () => {
    vi.useFakeTimers();
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    let resolve!: () => void;
    const poll = vi.fn((signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return new Promise<void>((done) => { resolve = done; });
    });
    const stop = startAdaptivePolling(poll);
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event("focus"));
    expect(poll).toHaveBeenCalledOnce();
    resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
    expect(poll.mock.calls[1][0].aborted).toBe(true);
    resolve();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("applies terminal responses immediately and stops without a trailing poll", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => false);
    startAdaptivePolling(poll);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a late old snapshot after replacement while the new poll remains independent", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    let snapshot = "initial";
    const stop = startAdaptivePolling(async (signal) => {
      const value = await new Promise<string>((done) => { resolve = done; });
      if (signal.aborted) return false;
      snapshot = value;
    });
    stop();
    startAdaptivePolling(async () => { snapshot = "new scan"; return false; });
    resolve("old scan");
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toBe("new scan");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queues explicit refresh behind an outstanding request", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const poll = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const stop = startAdaptivePolling(poll);
    stop.refresh();
    stop.refresh();
    expect(poll).toHaveBeenCalledOnce();
    resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
    resolve();
  });

  it("surfaces request errors immediately and retries serially", async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const poll = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(false);
    startAdaptivePolling(poll, error);
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it.each([[100_000, 49], [300_000, 116]])("bounds polls over %i ms at %i requests", async (duration, expected) => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => true);
    const stop = startAdaptivePolling(poll);
    await vi.advanceTimersByTimeAsync(duration);
    stop();
    expect(poll).toHaveBeenCalledTimes(expected);
    expect([0, 10_000, 60_000].map(pollingInterval)).toEqual([1_000, 2_000, 3_000]);
  });
});
