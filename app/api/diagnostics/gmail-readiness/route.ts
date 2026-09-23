import { timingSafeEqual } from "node:crypto";
import { productionProviderChecks } from "@/lib/server/production-config";

// Temporary operator diagnostic. Remove after the production configuration issue is identified.
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
    const checks = productionProviderChecks(process.env).gmail;
    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    return Response.json({ authorized: true, gmailAvailable: failedChecks.length === 0, checks, failedChecks }, { headers });
  } catch {
    return Response.json({ authorized: true, diagnosticAvailable: false }, { status: 500, headers });
  }
}
