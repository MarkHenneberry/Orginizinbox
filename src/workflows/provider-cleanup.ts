import { FatalError } from "workflow";
import type { VerificationTrace } from "@/lib/server/outlook-verification-timing";

export async function providerCleanupWorkflow(jobId: string, operation: "prepare" | "cleanup" | "undo", trace?: VerificationTrace) {
  "use workflow";
  while (true) {
    const result = await runProviderCleanupStep(jobId, operation, trace);
    if (result.verificationTrace) trace = result.verificationTrace;
    if (result.outcome === "stop") return result;
  }
}

export async function runProviderCleanupStep(jobId: string, operation: "prepare" | "cleanup" | "undo", trace?: VerificationTrace) {
  "use step";
  try {
    const { advanceOutlookCleanupJob } = await import("@/lib/server/outlook-cleanup");
    return await advanceOutlookCleanupJob(jobId, operation, trace);
  } catch {
    throw new FatalError("The provider cleanup step stopped safely.");
  }
}

runProviderCleanupStep.maxRetries = 0;
