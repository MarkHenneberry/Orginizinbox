import "server-only";
import { GmailScalableCleanupError } from "@/lib/server/gmail-scalable-cleanup-runner";

export function scalableCleanupResponse(error: unknown) {
  if (error instanceof GmailScalableCleanupError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json(
    { error: error instanceof Error && error.message.includes("required") ? error.message : "Scalable cleanup could not continue safely." },
    { status: error instanceof Error && error.message.includes("required") ? 400 : 500 }
  );
}
