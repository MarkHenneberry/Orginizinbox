const maxGmailBatchSize = 1000;

export type TrashMutationResult = {
  requested: number;
  attemptedCount: number;
  verifiedCount: number;
  failedCount: number;
  uncertainCount: number;
  verifiedTrashCount: number;
};

export function chunkMessageIds(ids: string[], size = maxGmailBatchSize): string[][] {
  if (!Number.isInteger(size) || size < 1 || size > maxGmailBatchSize) {
    throw new Error("Gmail batch size must be between 1 and 1000.");
  }
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export function summarizeTrashMutationResult(input: { requested: number; attemptedCount: number; verifiedCount: number; failedCount: number; uncertainCount: number }): TrashMutationResult {
  assertTrashAccounting(input);
  return {
    requested: input.requested,
    attemptedCount: input.attemptedCount,
    verifiedCount: input.verifiedCount,
    failedCount: input.failedCount,
    uncertainCount: input.uncertainCount,
    verifiedTrashCount: input.verifiedCount
  };
}

export function assertTrashAccounting(input: { attemptedCount: number; verifiedCount: number; failedCount: number; uncertainCount: number }) {
  if (input.attemptedCount !== input.verifiedCount + input.failedCount + input.uncertainCount) {
    throw new Error("Invalid Gmail cleanup result accounting.");
  }
}
