import "server-only";
import { start } from "workflow/api";
import { providerCleanupWorkflow } from "@/workflows/provider-cleanup";

export function startProviderCleanupWorkflow(jobId: string, operation: "prepare" | "cleanup" | "undo") {
  return start(providerCleanupWorkflow, [jobId, operation]);
}
