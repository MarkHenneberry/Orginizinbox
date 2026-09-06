import "server-only";
import { start } from "workflow/api";
import { providerScanWorkflow } from "@/workflows/provider-scan";

export function startProviderScanWorkflow(scanId: string) {
  return start(providerScanWorkflow, [scanId]);
}
