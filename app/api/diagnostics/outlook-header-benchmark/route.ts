import { timingSafeEqual } from "node:crypto";
import { getSession } from "@/lib/server/session";
import { getActiveMicrosoftConnection } from "@/lib/server/microsoft-connection";
import { createProviderRequestCoordinator } from "@/lib/server/provider-request-coordinator";
import { runOutlookHeaderBenchmark } from "@/lib/server/outlook-header-benchmark";
import { runOutlookCandidateCount } from "@/lib/server/outlook-candidate-count";
import { runOutlookExtendedHeaderBenchmark } from "@/lib/server/outlook-extended-header-benchmark";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store", "Vercel-CDN-Cache-Control": "no-store" };

// Temporary operator-only experiment. Remove after measuring the header payload cost.
export async function POST(request: Request) {
  if (process.env.OUTLOOK_HEADER_BENCHMARK_ENABLED !== "true") return Response.json({ available: false }, { status: 404, headers });
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) return Response.json({ authorized: false }, { status: 503, headers });
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return Response.json({ authorized: false }, { status: 401, headers });
  try {
    const session = await getSession();
    if (!session) return Response.json({ authorized: false }, { status: 401, headers });
    const connection = await getActiveMicrosoftConnection(session.userId, session.providerConnectionId);
    if (!connection) return Response.json({ available: false }, { status: 403, headers });
    const body = await request.json();
    const candidateCount = body?.mode === "candidate_count";
    const extendedHeaders = body?.mode === "extended_headers";
    if (!candidateCount && !extendedHeaders && body?.order !== "headers_first" && body?.order !== "no_headers_first") return Response.json({ valid: false }, { status: 400, headers });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(candidateCount ? 270_000 : 180_000)]);
    const coordinate = createProviderRequestCoordinator(connection.connection.id, {
      async beforeRequest() {
        signal.throwIfAborted();
        const current = await getSession();
        if (!current || current.userId !== session.userId || current.providerConnectionId !== session.providerConnectionId) {
          throw new DOMException("Authorization ended", "AbortError");
        }
        if (!await getActiveMicrosoftConnection(session.userId, session.providerConnectionId)) {
          throw new DOMException("Connection ended", "AbortError");
        }
      }
    });
    const result = extendedHeaders ? await runOutlookExtendedHeaderBenchmark({ accessToken: connection.accessToken, signal, coordinate })
      : candidateCount ? await runOutlookCandidateCount({ accessToken: connection.accessToken, signal, coordinate })
      : await runOutlookHeaderBenchmark({ accessToken: connection.accessToken, signal,
      noHeadersFirst: body.order === "no_headers_first", coordinate });
    return Response.json(result, { headers });
  } catch {
    return Response.json({ success: false }, { status: 503, headers });
  }
}
