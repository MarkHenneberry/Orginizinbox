import { NextResponse } from "next/server";
import {
  createGmailCleanupPreview,
  GmailCleanupError,
  parseCleanupCount,
  parseCleanupGroupIndices
} from "@/lib/server/gmail-cleanup";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      groupIndices?: unknown;
      requestedCount?: unknown;
      benchmarkOnly?: unknown;
    };

    const preview = await createGmailCleanupPreview({
      groupIndices: parseCleanupGroupIndices(body.groupIndices),
      requestedCount: parseCleanupCount(body.requestedCount),
      benchmarkOnly: body.benchmarkOnly === true
    });
    return NextResponse.json({ job: preview });
  } catch (error) {
    return cleanupErrorResponse(error);
  }
}

function cleanupErrorResponse(error: unknown) {
  if (error instanceof GmailCleanupError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json({ error: "Gmail cleanup preview failed." }, { status: 500 });
}
