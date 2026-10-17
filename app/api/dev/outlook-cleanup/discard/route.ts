import { discardOutlookCleanup } from "@/lib/server/outlook-cleanup";
import { outlookCleanupResponse } from "@/lib/server/outlook-cleanup-route";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  try {
    const body = await request.json() as { jobId?: unknown; confirmed?: unknown };
    if (typeof body.jobId !== "string" || body.confirmed !== true) return new Response(null, { status: 400 });
    return Response.json(await discardOutlookCleanup(body.jobId));
  } catch (error) { return outlookCleanupResponse(error); }
}
