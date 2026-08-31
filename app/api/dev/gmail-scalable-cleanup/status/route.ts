import { getGmailScalableCleanupStatus } from "@/lib/server/gmail-scalable-cleanup-runner";
import { scalableCleanupResponse } from "@/lib/server/gmail-scalable-cleanup-route";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { jobId?: unknown };
    if (typeof body.jobId !== "string" || !body.jobId) throw new Error("Scalable cleanup job id is required.");
    return Response.json({ job: await getGmailScalableCleanupStatus(body.jobId) });
  } catch (error) {
    return scalableCleanupResponse(error);
  }
}
