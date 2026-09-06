import { sanitizeReportForClient } from "@/lib/domain/report-sanitizer";
import { getLiveScan, serializeScanProgress } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export async function GET() {
  const session = await getSession();
  if (!session?.userId) return Response.json({ error: "Not connected.", progress: null }, { status: 401 });

  const liveScan = await getLiveScan(session.userId, "microsoft");
  if (liveScan && liveScan.progress.provider !== "microsoft") {
    return Response.json({ progress: null, report: null, reportStale: false });
  }
  return Response.json({
    progress: liveScan ? serializeScanProgress(liveScan.progress) : null,
    report: liveScan?.report ? sanitizeReportForClient(liveScan.report) : null,
    reportStale: liveScan?.reportStale === true
  });
}
