import { getSession } from "@/lib/server/session";
import { prisma } from "@/lib/server/db";
import { PrismaCleanupJobStore } from "@/lib/server/cleanup-job-store";
import { acceptPermanentDelete, deletionProvider, deletionView, type DeleteJob } from "@/lib/server/permanent-delete";
import { assertProductionCleanupInfrastructure, requireProductionCleanupAccess } from "@/lib/server/production-cleanup";
import { start } from "workflow/api";
import { permanentDeleteWorkflow } from "@/workflows/permanent-delete";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  if (process.env.NODE_ENV !== "production") return new Response(null, { status: 404, headers });
  try {
    const origin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").origin;
    if (request.headers.get("origin") !== origin || new URL(request.url).origin !== origin) return new Response(null, { status: 403, headers });
    const session = await getSession();
    if (!session) return new Response(null, { status: 401, headers });
    const { provider } = await context.params;
    if (provider !== "gmail" && provider !== "microsoft") return new Response(null, { status: 404, headers });
    const body = await request.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Object.keys(body).some(key => !["jobId", "action", "confirmed", "acknowledged"].includes(key)) ||
      typeof body.jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.jobId) || !["status", "delete"].includes(String(body.action))) {
      return new Response(null, { status: 400, headers });
    }
    if (body.action === "delete" && (body.confirmed !== true || body.acknowledged !== true)) return new Response(null, { status: 400, headers });
    await requireProductionCleanupAccess({ provider, access: "recovery", userId: session.userId,
      providerConnectionId: session.providerConnectionId, jobId: body.jobId });
    const store = new PrismaCleanupJobStore<DeleteJob>();
    let job = await store.get(session.userId, body.jobId);
    if (!job || deletionProvider(job) !== provider) return new Response(null, { status: 410, headers });
    // Match the job's owning provider even if a stale client retained a job ID.
    if (!await prisma.cleanupJob.count({ where: { id: body.jobId, scan: { userId: session.userId, provider, providerConnectionId: session.providerConnectionId } } })) {
      return new Response(null, { status: 404, headers });
    }
    if (body.action === "delete") {
      assertProductionCleanupInfrastructure(provider, "forward");
      job = await acceptPermanentDelete(session.userId, body.jobId, provider, store);
      // Repeated confirmation can recover scheduling failure; durable dispatch prevents repeat deletion.
      if (job.permanentDeletion?.status === "running") await start(permanentDeleteWorkflow, [body.jobId]);
    }
    let canDelete = true;
    try { assertProductionCleanupInfrastructure(provider, "forward"); } catch { canDelete = false; }
    return Response.json({ deletion: deletionView(job), canDelete }, { headers });
  } catch {
    return Response.json({ error: "Permanent deletion could not continue. Check its status before trying again." }, { status: 503, headers });
  }
}
