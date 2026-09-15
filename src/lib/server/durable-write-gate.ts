import "server-only";

// Only for redundant progress/heartbeat writes, never mutation or recovery checkpoints.
export function createDurableWriteGate(intervalMs: number, now: () => number = Date.now, initiallyDue = true) {
  let lastWrite = initiallyDue ? Number.NEGATIVE_INFINITY : now();
  return async (write: () => Promise<unknown>, force = false) => {
    if (!force && now() - lastWrite < intervalMs) return false;
    await write();
    lastWrite = now();
    return true;
  };
}
