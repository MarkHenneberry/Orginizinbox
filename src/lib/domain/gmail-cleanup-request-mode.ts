export const gmailLegacyCleanupHardMaximum = 100;
export const gmailScalableCleanupDevCounts = [250, 500] as const;

export type GmailCleanupRequestMode = "legacy" | "scalable" | "invalid";

export function getGmailCleanupRequestMode(input: {
  requestedCount: number;
  legacyMaximum: number;
  scalableEnabled: boolean;
}): GmailCleanupRequestMode {
  if (!Number.isInteger(input.requestedCount) || input.requestedCount < 1) return "invalid";

  const legacyMaximum = Math.min(input.legacyMaximum, gmailLegacyCleanupHardMaximum);
  if (Number.isInteger(legacyMaximum) && legacyMaximum >= 1 && input.requestedCount <= legacyMaximum) {
    return "legacy";
  }

  if (
    input.scalableEnabled &&
    gmailScalableCleanupDevCounts.includes(input.requestedCount as (typeof gmailScalableCleanupDevCounts)[number])
  ) {
    return "scalable";
  }

  return "invalid";
}
