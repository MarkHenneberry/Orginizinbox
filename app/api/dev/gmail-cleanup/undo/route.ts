import { NextResponse } from "next/server";
import { GmailCleanupError, undoGmailCleanup } from "@/lib/server/gmail-cleanup";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      throw new GmailCleanupError("Cleanup result id is required.", 400);
    }
    const job = await undoGmailCleanup({ jobId: body.jobId });
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof GmailCleanupError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Gmail cleanup undo failed." }, { status: 500 });
  }
}
