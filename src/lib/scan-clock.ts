export function scanClockStart(pending: boolean, operationStartedAt?: number, durableStartedAt?: number) {
  return pending ? operationStartedAt : durableStartedAt ?? operationStartedAt;
}

export function advanceScanElapsed(serverElapsedMs: number, receivedMonotonicMs: number, nowMonotonicMs: number) {
  return Math.max(0, serverElapsedMs) + Math.max(0, nowMonotonicMs - receivedMonotonicMs);
}
