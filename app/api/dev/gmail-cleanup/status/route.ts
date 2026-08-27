import { NextResponse } from "next/server";
import { getGmailCleanupStatus, GmailCleanupError } from "@/lib/server/gmail-cleanup";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) throw new GmailCleanupError("Cleanup operation id is required.", 400);
    return NextResponse.json({ job: await getGmailCleanupStatus(body.jobId) });
  } catch (error) {
    if (error instanceof GmailCleanupError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Cleanup operation status is unavailable." }, { status: 500 });
  }
}
