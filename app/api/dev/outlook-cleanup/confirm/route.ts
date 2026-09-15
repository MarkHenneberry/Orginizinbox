import { confirmOutlookCleanup } from "@/lib/server/outlook-cleanup";
import { outlookCleanupResponse } from "@/lib/server/outlook-cleanup-route";

import { productionCleanupBoundary } from "@/lib/billing/cleanup-boundary";

export async function POST(request: Request) {
  const denied = await productionCleanupBoundary(request);
  if (denied) return denied;
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  try {
    const body = await request.json() as { jobId?: unknown; confirmed?: unknown };
    if (typeof body.jobId !== "string" || body.confirmed !== true) throw new Error("Explicit cleanup confirmation is required.");
    return Response.json({ job: await confirmOutlookCleanup(body.jobId) });
  } catch (error) {
    return outlookCleanupResponse(error);
  }
}
