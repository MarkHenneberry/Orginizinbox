import { startGmailScalableCleanup } from "@/lib/server/gmail-scalable-cleanup-runner";
import { scalableCleanupResponse } from "@/lib/server/gmail-scalable-cleanup-route";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { groupIndices?: unknown; requestedCount?: unknown };
    return Response.json({
      job: await startGmailScalableCleanup({
        groupIndices: body.groupIndices,
        requestedCount: body.requestedCount
      })
    }, { status: 202 });
  } catch (error) {
    return scalableCleanupResponse(error);
  }
}
