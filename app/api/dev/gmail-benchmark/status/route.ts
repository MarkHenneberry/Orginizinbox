import { runtimeConfig } from "@/lib/config";
import { sanitizeReportForClient } from "@/lib/domain/report-sanitizer";
import { assertDevBenchmarkEnabled } from "@/lib/server/gmail-benchmark";
import { getLiveScan, serializeBenchmark } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export async function GET() {
  try {
    assertDevBenchmarkEnabled(runtimeConfig.gmailBenchmarkEnabled);
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Not connected.", progress: null }, { status: 401 });

    const liveScan = getLiveScan(session.userId);
    return Response.json({
      progress: liveScan ? serializeBenchmark(liveScan.progress) : null,
      report: liveScan?.report ? sanitizeReportForClient(liveScan.report) : null
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Benchmark status is unavailable." }, { status: 403 });
  }
}
