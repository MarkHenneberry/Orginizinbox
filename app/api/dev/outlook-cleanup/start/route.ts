import { startOutlookCleanup } from "@/lib/server/outlook-cleanup";
import { outlookCleanupResponse } from "@/lib/server/outlook-cleanup-route";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { groupIndices?: unknown; requestedCount?: unknown };
    return Response.json({ job: await startOutlookCleanup({
      groupIndices: body.groupIndices,
      requestedCount: body.requestedCount
    }) });
  } catch (error) {
    return outlookCleanupResponse(error);
  }
}
