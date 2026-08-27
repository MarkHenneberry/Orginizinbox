import { NextResponse } from "next/server";
import { confirmGmailCleanup, GmailCleanupError } from "@/lib/server/gmail-cleanup";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { jobId?: string; confirmation?: string };
    if (!body.jobId) {
      throw new GmailCleanupError("Cleanup preview id is required.", 400);
    }
    const job = await confirmGmailCleanup({
      jobId: body.jobId,
      confirmation: body.confirmation ?? ""
    });
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof GmailCleanupError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Gmail cleanup failed." }, { status: 500 });
  }
}
