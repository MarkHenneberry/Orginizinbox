import { FatalError } from "workflow";

export async function providerCleanupWorkflow(jobId: string, operation: "prepare" | "cleanup" | "undo") {
  "use workflow";
  while (true) {
    const result = await runProviderCleanupStep(jobId, operation);
    if (result.outcome === "stop") return result;
  }
}

export async function runProviderCleanupStep(jobId: string, operation: "prepare" | "cleanup" | "undo") {
  "use step";
  try {
    const { advanceOutlookCleanupJob } = await import("@/lib/server/outlook-cleanup");
    return await advanceOutlookCleanupJob(jobId, operation);
  } catch {
    throw new FatalError("The provider cleanup step stopped safely.");
  }
}

runProviderCleanupStep.maxRetries = 0;
