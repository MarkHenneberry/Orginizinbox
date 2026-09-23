import { timingSafeEqual } from "node:crypto";
import { getSession } from "@/lib/server/session";
import { getLiveScan } from "@/lib/server/live-scan-store";
import { safeGmailScanFailure } from "@/lib/server/gmail-scan-failure";

// Temporary operator diagnostic. Remove after identifying the production scan failure.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vercel-CDN-Cache-Control": "no-store" };

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) return Response.json({ authorized: false }, { status: 503, headers });
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return Response.json({ authorized: false }, { status: 401, headers });
  }
  try {
    const session = await getSession();
    if (!session) return Response.json({ authorized: false }, { status: 401, headers });
    const scan = await getLiveScan(session.userId, "gmail");
    const failed = scan?.progress.status === "failed";
    return Response.json({
      scanFound: Boolean(scan),
      failureCategory: scan?.progress.status === "cancelled" ? "cancelled"
        : failed ? safeGmailScanFailure(scan.progress.gmailFailureCategory) : null
    }, { headers });
  } catch {
    return Response.json({ diagnosticAvailable: false, failureCategory: "durable_state_failed" }, { status: 503, headers });
  }
}
