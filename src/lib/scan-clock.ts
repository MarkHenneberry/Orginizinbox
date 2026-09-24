export function scanClockStart(pending: boolean, operationStartedAt?: number, durableStartedAt?: number) {
  return pending ? operationStartedAt : durableStartedAt ?? operationStartedAt;
}
