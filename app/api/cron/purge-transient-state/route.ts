import { timingSafeEqual } from "node:crypto";
import { purgeExpiredTransientState } from "@/lib/server/transient-state-purge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Retention scheduler is not configured." }, { status: 503, headers });
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  }

  const result = await purgeExpiredTransientState();
  console.info("transient_state_purge", result);
  return Response.json(result, { status: result.status === "success" ? 200 : 503, headers });
}

// Do not allow Next's implicit HEAD-to-GET fallback to execute the purge.
export function HEAD() {
  return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
}
