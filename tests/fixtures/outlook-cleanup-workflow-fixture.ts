import {
  getOutlookCleanupBatchSize,
  getOutlookCleanupTotalBatches,
  outlookCleanupChunkSize
} from "@/lib/domain/outlook-cleanup";

type FixtureOperation = "cleanup" | "undo";

export async function outlookCleanupBatchFixtureWorkflow(
  requested: number,
  operation: FixtureOperation,
  uncertainBatch?: number
) {
  "use workflow";
  const totalBatches = getOutlookCleanupTotalBatches(requested);
  const totalChunks = Math.ceil(requested / outlookCleanupChunkSize);
  let completedBatches = 0;
  let completedChunks = 0;
  let processed = 0;

  while (completedChunks < totalChunks) {
    const result = await runOutlookFixtureChunk(
      requested,
      operation,
      completedBatches,
      uncertainBatch
    );
    if (result.uncertain) {
      return {
        status: "uncertain" as const,
        completedBatches: completedBatches + result.completedBatches,
        processed: processed + result.processed,
        totalBatches
      };
    }
    completedBatches += result.completedBatches;
    completedChunks += 1;
    processed += result.processed;
  }

  return {
    status: "complete" as const,
    completedBatches,
    processed,
    totalBatches,
    totalChunks,
    httpRoundTrips: totalBatches * (operation === "cleanup" ? 3 : 2),
    graphSubrequests: requested * (operation === "cleanup" ? 3 : 2)
  };
}

async function runOutlookFixtureChunk(
  requested: number,
  operation: FixtureOperation,
  completedBatches: number,
  uncertainBatch?: number
) {
  "use step";
  const batchSize = getOutlookCleanupBatchSize(requested);
  const remaining = requested - completedBatches * batchSize;
  const chunkMessages = Math.min(outlookCleanupChunkSize, remaining);
  const chunkBatches = Math.ceil(chunkMessages / batchSize);
  if (
    uncertainBatch !== undefined &&
    uncertainBatch > completedBatches &&
    uncertainBatch <= completedBatches + chunkBatches
  ) {
    const safeBatches = uncertainBatch - completedBatches - 1;
    return {
      uncertain: true as const,
      completedBatches: safeBatches,
      processed: safeBatches * batchSize
    };
  }
  return {
    uncertain: false as const,
    operation,
    completedBatches: chunkBatches,
    processed: chunkMessages
  };
}

runOutlookFixtureChunk.maxRetries = 0;
