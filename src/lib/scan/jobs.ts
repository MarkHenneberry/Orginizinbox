import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import type { InboxReport } from "@/lib/domain/types";
import type { MailboxProcessor } from "@/lib/providers/types";

export type ScanJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ScanJobState = {
  id: string;
  status: ScanJobStatus;
  failureCode?: string;
};

export type ScanWorkerResult = {
  state: ScanJobState;
  report: InboxReport;
};

export async function runScanWorker(
  provider: MailboxProcessor,
  state: ScanJobState,
  providerName: "gmail" | "microsoft",
  batchSize = 500
): Promise<ScanWorkerResult> {
  const aggregator = new StreamingReportAggregator();
  if (state.status === "completed" || state.status === "cancelled") {
    return {
      state,
      report: aggregator.snapshot(providerName, false)
    };
  }

  for await (const batch of provider.scanMetadata({
    batchSize
  })) {
    aggregator.processBatch(batch.records);
  }

  return {
    state: {
      ...state,
      status: "completed"
    },
    report: aggregator.snapshot(providerName, false)
  };
}
