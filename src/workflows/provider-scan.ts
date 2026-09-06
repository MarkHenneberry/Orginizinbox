import { sleep } from "workflow";

export async function providerScanWorkflow(scanId: string) {
  "use workflow";
  while (true) {
    const result = await runProviderScanStep(scanId);
    if (result.outcome !== "locked") return result;
    await sleep(new Date(Date.now() + 60_000));
  }
}

export async function runProviderScanStep(scanId: string) {
  "use step";
  const { runDurableProviderScan } = await import("@/lib/server/provider-scan-runner");
  return runDurableProviderScan(scanId);
}

runProviderScanStep.maxRetries = 2;
