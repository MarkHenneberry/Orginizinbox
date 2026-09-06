import "server-only";
import { randomUUID } from "node:crypto";
import { runGmailBenchmark } from "@/lib/server/gmail-benchmark";
import { claimLiveScan, getLiveScanById, releaseLiveScan } from "@/lib/server/live-scan-store";
import { runMicrosoftScan } from "@/lib/server/microsoft-scan";

export async function runDurableProviderScan(scanId: string) {
  const owner = `scan-worker:${randomUUID()}`;
  const current = await getLiveScanById(scanId);
  if (!current || current.progress.status !== "running") return { outcome: "not_running" as const };
  const session = await claimLiveScan(scanId, owner);
  if (!session) return { outcome: "locked" as const };
  try {
    if (session.progress.provider === "microsoft") {
      await runMicrosoftScan({ scanId, lockOwner: owner });
    } else {
      await runGmailBenchmark({ scanId, lockOwner: owner });
    }
    return { outcome: "completed" as const };
  } finally {
    await releaseLiveScan(scanId, owner);
  }
}
