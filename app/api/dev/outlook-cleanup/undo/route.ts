import { undoOutlookCleanup } from "@/lib/server/outlook-cleanup";
import { outlookCleanupResponse } from "@/lib/server/outlook-cleanup-route";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { jobId?: unknown; confirmed?: unknown };
    if (typeof body.jobId !== "string" || body.confirmed !== true) throw new Error("Explicit Undo confirmation is required.");
    return Response.json({ job: await undoOutlookCleanup(body.jobId) });
  } catch (error) {
    return outlookCleanupResponse(error);
  }
}
