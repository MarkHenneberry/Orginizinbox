import "server-only";
import { start } from "workflow/api";
import { providerCleanupWorkflow } from "@/workflows/provider-cleanup";
import type { VerificationTrace } from "@/lib/server/outlook-verification-timing";

export function startProviderCleanupWorkflow(jobId: string, operation: "prepare" | "cleanup" | "undo", trace?: VerificationTrace) {
  return start(providerCleanupWorkflow, trace ? [jobId, operation, trace] : [jobId, operation]);
}
