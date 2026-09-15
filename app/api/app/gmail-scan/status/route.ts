import { sanitizeReportForClient } from "@/lib/domain/report-sanitizer";
import { runtimeConfig } from "@/lib/config";
import { getLiveScan, serializeScanProgress } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export async function GET() {
  if (!runtimeConfig.gmailAvailable) return Response.json({ error: "Gmail is temporarily unavailable.", progress: null }, { status: 503 });
  const session = await getSession();
  if (!session?.userId) return Response.json({ error: "Not connected.", progress: null }, { status: 401 });

  const liveScan = await getLiveScan(session.userId, "gmail");
  return Response.json({
    progress: liveScan ? serializeScanProgress(liveScan.progress) : null,
    report: liveScan?.report ? sanitizeReportForClient(liveScan.report) : null,
    reportStale: liveScan?.reportStale === true
  });
}
