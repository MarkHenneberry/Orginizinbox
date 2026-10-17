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
    const latest = await getLiveScanById(scanId);
    return { outcome: latest?.progress.status === "completed" ? "completed" as const : "stopped" as const };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { outcome: "stopped" as const };
    throw error;
  } finally {
    await releaseLiveScan(scanId, owner);
  }
}
