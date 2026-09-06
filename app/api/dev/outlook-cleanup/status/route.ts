import { getOutlookCleanupStatus } from "@/lib/server/outlook-cleanup";
import { outlookCleanupResponse } from "@/lib/server/outlook-cleanup-route";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { jobId?: unknown };
    if (typeof body.jobId !== "string" || !body.jobId) throw new Error("Cleanup job ID is required.");
    return Response.json({ job: await getOutlookCleanupStatus(body.jobId) });
  } catch (error) {
    return outlookCleanupResponse(error);
  }
}
