import { confirmGmailScalableCleanup } from "@/lib/server/gmail-scalable-cleanup-runner";
import { scalableCleanupResponse } from "@/lib/server/gmail-scalable-cleanup-route";

import { productionCleanupBoundary } from "@/lib/billing/cleanup-boundary";

export async function POST(request: Request) {
  const denied = await productionCleanupBoundary(request);
  if (denied) return denied;
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  try {
    const body = (await request.json()) as { jobId?: unknown; confirmation?: unknown };
    if (typeof body.jobId !== "string" || body.confirmation !== "MOVE_TO_TRASH") {
      throw new Error("Explicit Trash confirmation is required.");
    }
    return Response.json({ job: await confirmGmailScalableCleanup(body.jobId) }, { status: 202 });
  } catch (error) {
    return scalableCleanupResponse(error);
  }
}
