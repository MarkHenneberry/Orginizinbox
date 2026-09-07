export const scanStateTtlMs = 60 * 60 * 1000;
export const transientPurgeIntervalMs = 60 * 1000;
export const legacyCleanupTtlMs = 10 * 60 * 1000;

export function expiredUnlockedStateWhere(now: Date) {
  return {
    expiresAt: { lte: now },
    OR: [{ lockExpiresAt: null }, { lockExpiresAt: { lte: now } }]
  };
}

export function retentionDuration(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
