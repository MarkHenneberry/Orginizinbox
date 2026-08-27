import { z } from "zod";
import { runtimeConfig } from "@/lib/config";
import { assertDevBenchmarkEnabled, createGmailBenchmarkSession, isBenchmarkLimit } from "@/lib/server/gmail-benchmark";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { clearLiveScan, reuseRunningLiveScan, serializeBenchmark } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

const startSchema = z.object({
  limit: z.union([z.literal(5000), z.literal(10000), z.literal(25000), z.literal(50000), z.literal(100000), z.literal("full")]),
  batchSize: z.number().int().min(100).max(5000).default(1000)
});

export async function POST(request: Request) {
  try {
    assertDevBenchmarkEnabled(runtimeConfig.gmailBenchmarkEnabled);
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Connect Gmail before starting a benchmark." }, { status: 401 });

    const body = await request.json();
    const parsed = startSchema.parse(body);
    if (!isBenchmarkLimit(parsed.limit)) return Response.json({ error: "Unsupported benchmark limit." }, { status: 400 });

    const activeConnection = await getActiveGmailConnection(session.userId, session.providerConnectionId);
    if (!activeConnection) return Response.json({ error: "Connect Gmail before starting a benchmark." }, { status: 401 });

    const running = reuseRunningLiveScan(session.userId);
    if (running) return Response.json({ progress: serializeBenchmark(running.progress), reused: true });

    clearLiveScan(session.userId);
    const progress = createGmailBenchmarkSession({
      userId: session.userId,
      providerConnectionId: session.providerConnectionId,
      limit: parsed.limit,
      batchSize: parsed.batchSize
    });

    return Response.json({ progress: serializeBenchmark(progress) });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Invalid benchmark request." }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : "Benchmark could not be started." }, { status: 403 });
  }
}
