import "server-only";
import { OutlookCleanupError } from "@/lib/server/outlook-cleanup";

export function outlookCleanupResponse(error: unknown) {
  if (error instanceof OutlookCleanupError) {
    return Response.json({ error: error.message }, { status: error.statusCode });
  }
  return Response.json({ error: "Outlook cleanup stopped safely." }, { status: 500 });
}
