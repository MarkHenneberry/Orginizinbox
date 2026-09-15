import { createGmailScanSession } from "@/lib/server/gmail-benchmark";
import { runtimeConfig } from "@/lib/config";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { serializeScanProgress } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";
import { scanStartFailure } from "@/lib/server/scan-start-response";

export async function POST() {
  if (!runtimeConfig.gmailAvailable) return Response.json({ error: "Gmail is temporarily unavailable." }, { status: 503 });
  let phase: "connection" | "start" = "connection";
  try {
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Connect Gmail before scanning." }, { status: 401 });

    const activeConnection = await getActiveGmailConnection(session.userId, session.providerConnectionId);
    if (!activeConnection) return Response.json({ error: "Connect Gmail before scanning." }, { status: 401 });

    phase = "start";
    const accepted = await createGmailScanSession({
      userId: session.userId,
      providerConnectionId: activeConnection.connection.id
    });

    return Response.json({ progress: serializeScanProgress(accepted.progress), reused: accepted.reused });
  } catch {
    return scanStartFailure("gmail", phase);
  }
}
