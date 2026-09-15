import { productionCleanupBoundary } from "@/lib/billing/cleanup-boundary";
import { productionCleanupJobView } from "@/lib/server/production-cleanup-response";
import { ProductionCleanupError } from "@/lib/server/production-cleanup";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request, context: { params: Promise<{ provider: string; action: string }> }) {
  if (process.env.NODE_ENV !== "production") return new Response(null, { status: 404, headers });
  const { provider, action } = await context.params;
  if ((provider !== "gmail" && provider !== "microsoft") || !["start", "confirm", "status", "undo"].includes(action)) {
    return new Response(null, { status: 404, headers });
  }
  try {
    const body = await request.json() as { requestedCount?: unknown; groupIndices?: unknown; jobId?: unknown; confirmed?: unknown };
    if (!body || typeof body !== "object") return new Response(null, { status: 400, headers });
    const jobId = typeof body.jobId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(body.jobId) ? body.jobId : undefined;
    if (action !== "start" && !jobId) return Response.json({ error: "An existing cleanup job is required." }, { status: 400, headers });
    if ((action === "confirm" || action === "undo") && body.confirmed !== true) {
      return Response.json({ error: "Explicit confirmation is required." }, { status: 400, headers });
    }
    const denied = await productionCleanupBoundary(request, { provider,
      access: action === "undo" || action === "status" ? "recovery" : "forward", jobId: action === "start" ? undefined : jobId });
    if (denied) return denied;
    if (action === "start" && (typeof body.requestedCount !== "number" || !Number.isInteger(body.requestedCount) ||
        (provider === "gmail" ? ![250, 500].includes(body.requestedCount) : body.requestedCount < 1 || body.requestedCount > 500))) {
      return Response.json({ error: "Choose a supported cleanup size." }, { status: 400, headers });
    }
    const input = { groupIndices: body.groupIndices, requestedCount: body.requestedCount };
    let job;
    if (provider === "gmail") {
      const service = await import("@/lib/server/gmail-scalable-cleanup-runner");
      job = action === "start" ? await service.startGmailScalableCleanup(input)
        : action === "confirm" ? await service.confirmGmailScalableCleanup(jobId!)
        : action === "undo" ? await service.undoGmailScalableCleanup(jobId!)
        : await service.getGmailScalableCleanupStatus(jobId!);
    } else {
      const service = await import("@/lib/server/outlook-cleanup");
      job = action === "start" ? await service.startOutlookCleanup(input)
        : action === "confirm" ? await service.confirmOutlookCleanup(jobId!)
        : action === "undo" ? await service.undoOutlookCleanup(jobId!)
        : await service.getOutlookCleanupStatus(jobId!);
    }
    if (!job) return Response.json({ error: "Cleanup state is unavailable or expired." }, { status: 410, headers });
    return Response.json({ job: productionCleanupJobView(job) }, { headers });
  } catch (error) {
    if (error instanceof ProductionCleanupError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    return Response.json({ error: "Cleanup could not continue. Check its status before trying again." }, { status: 503, headers });
  }
}
