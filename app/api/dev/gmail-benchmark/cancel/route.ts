import { runtimeConfig } from "@/lib/config";
import { assertDevBenchmarkEnabled } from "@/lib/server/gmail-benchmark";
import { getLiveScan, serializeBenchmark } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export async function POST() {
  try {
    assertDevBenchmarkEnabled(runtimeConfig.gmailBenchmarkEnabled);
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Not connected." }, { status: 401 });
    const liveScan = getLiveScan(session.userId);
    if (!liveScan) return Response.json({ progress: null });

    liveScan.cancel.abort();
    liveScan.progress.status = "cancelled";
    liveScan.progress.completedAt = Date.now();
    liveScan.progress.durationMs = liveScan.progress.completedAt - liveScan.progress.startedAt;
    liveScan.progress.notes.push("Benchmark cancellation requested.");
    return Response.json({ progress: serializeBenchmark(liveScan.progress) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Benchmark could not be cancelled." }, { status: 403 });
  }
}
