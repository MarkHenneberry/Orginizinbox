import { sanitizeReportForClient } from "@/lib/domain/report-sanitizer";
import { getLiveScan, serializeScanProgress } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export async function GET() {
  const session = await getSession();
  if (!session?.userId) return Response.json({ error: "Not connected.", progress: null }, { status: 401 });

  const liveScan = getLiveScan(session.userId);
  return Response.json({
    progress: liveScan ? serializeScanProgress(liveScan.progress) : null,
    report: liveScan?.report ? sanitizeReportForClient(liveScan.report) : null,
    reportStale: liveScan?.reportStale === true
  });
}
