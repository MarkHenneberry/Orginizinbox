export const gmailQuotaUnits = {
  list: 5,
  previewMetadata: 20,
  confirmationLabels: 20,
  batchModify: 50,
  verificationLabels: 20,
  untrash: 5,
  undoFallbackLabels: 20
} as const;

export type GmailRequestKind = keyof typeof gmailQuotaUnits;

export type GmailRequestCounts = Record<GmailRequestKind, number>;

export function createGmailRequestCounts(): GmailRequestCounts {
  return {
    list: 0,
    previewMetadata: 0,
    confirmationLabels: 0,
    batchModify: 0,
    verificationLabels: 0,
    untrash: 0,
    undoFallbackLabels: 0
  };
}

export function calculateGmailQuotaUnits(counts: GmailRequestCounts) {
  return (Object.keys(gmailQuotaUnits) as GmailRequestKind[]).reduce(
    (total, kind) => total + counts[kind] * gmailQuotaUnits[kind],
    0
  );
}

export function estimateGmailCleanupQuota(input: {
  messageCount: number;
  senderGroupCount: number;
  confirmationLabelChecks?: number;
  undoFallbackVerificationCount?: number;
}) {
  const preview = input.senderGroupCount * gmailQuotaUnits.list + input.messageCount * gmailQuotaUnits.previewMetadata;
  const confirmation =
    input.senderGroupCount * gmailQuotaUnits.list +
    (input.confirmationLabelChecks ?? 0) * gmailQuotaUnits.confirmationLabels;
  const mutation = gmailQuotaUnits.batchModify;
  const verification = input.messageCount * gmailQuotaUnits.verificationLabels;
  const undo =
    input.messageCount * gmailQuotaUnits.untrash +
    (input.undoFallbackVerificationCount ?? 0) * gmailQuotaUnits.undoFallbackLabels;
  return {
    preview,
    confirmation,
    mutation,
    verification,
    beforeUndo: preview + confirmation + mutation + verification,
    undo,
    includingUndo: preview + confirmation + mutation + verification + undo
  };
}
