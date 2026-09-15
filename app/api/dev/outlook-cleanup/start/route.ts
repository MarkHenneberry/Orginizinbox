import { startOutlookCleanup } from "@/lib/server/outlook-cleanup";
import { outlookCleanupResponse } from "@/lib/server/outlook-cleanup-route";

import { productionCleanupBoundary } from "@/lib/billing/cleanup-boundary";

export async function POST(request: Request) {
  const denied = await productionCleanupBoundary(request);
  if (denied) return denied;
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
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
