import { NextResponse } from "next/server";
import { GmailCleanupError, startOverGmailCleanup } from "@/lib/server/gmail-cleanup";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) throw new GmailCleanupError("Cleanup operation id is required.", 400);
    return NextResponse.json(await startOverGmailCleanup(body.jobId));
  } catch (error) {
    if (error instanceof GmailCleanupError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "The cleanup check could not be discarded." }, { status: 500 });
  }
}
