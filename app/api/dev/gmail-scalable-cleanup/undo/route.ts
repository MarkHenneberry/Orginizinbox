import { undoGmailScalableCleanup } from "@/lib/server/gmail-scalable-cleanup-runner";
import { scalableCleanupResponse } from "@/lib/server/gmail-scalable-cleanup-route";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { jobId?: unknown; confirmation?: unknown };
    if (typeof body.jobId !== "string" || body.confirmation !== "RESTORE_FROM_TRASH") {
      throw new Error("Explicit scalable Undo confirmation is required.");
    }
    return Response.json({ job: await undoGmailScalableCleanup(body.jobId) }, { status: 202 });
  } catch (error) {
    return scalableCleanupResponse(error);
  }
}
