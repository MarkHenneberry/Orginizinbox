import { z } from "zod";
import { getSession } from "@/lib/server/session";

const duration = z.number().finite().min(0).max(30 * 60_000);
const sample = z.object({
  correlationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  clientTotalMs: duration, startRequestMs: duration, pollRequests: z.number().int().min(0).max(2000),
  pollHttpMs: duration, pollingAndWaitMs: duration, renderAfterReadyResponseMs: duration,
  readyCheckpointToVisibleUpperBoundMs: duration.optional()
}).strict();

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const origin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").origin;
    if (request.headers.get("origin") !== origin || new URL(request.url).origin !== origin) return new Response(null, { status: 403, headers });
    if (!await getSession()) return new Response(null, { status: 401, headers });
    const text = await request.text();
    if (text.length > 2048) return new Response(null, { status: 400, headers });
    const parsed = sample.safeParse(JSON.parse(text));
    if (!parsed.success) return new Response(null, { status: 400, headers });
    // Untrusted browser observations; never used for permissions, balances or job state.
    console.info("Outlook verification client-ready", { clientReported: true, ...parsed.data });
    return new Response(null, { status: 204, headers });
  } catch { return new Response(null, { status: 400, headers }); }
}
