import { createPrismaGmailScalableCleanupStore } from "@/lib/server/gmail-scalable-cleanup-durable-store";
import {
  startGmailScalableCleanupWorkflow,
  startGmailScalableUndoWorkflow
} from "@/lib/server/gmail-scalable-workflow-start";
import { getSession } from "@/lib/server/session";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const session = await getSession();
  if (!session?.userId) return Response.json({ error: "Connect Gmail first." }, { status: 401 });
  const body = (await request.json()) as { jobId?: unknown; operation?: unknown };
  if (typeof body.jobId !== "string" || !["cleanup", "undo"].includes(String(body.operation))) {
    return Response.json({ error: "An opaque cleanup job ID and operation are required." }, { status: 400 });
  }
  const state = await createPrismaGmailScalableCleanupStore().get(session.userId, body.jobId);
  if (!state) return Response.json({ error: "Cleanup state is unavailable or expired." }, { status: 410 });
  const run = body.operation === "undo"
    ? await startGmailScalableUndoWorkflow(body.jobId)
    : await startGmailScalableCleanupWorkflow(body.jobId);
  return Response.json({ runId: run.runId }, { status: 202 });
}
