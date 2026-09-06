import { createGmailScanSession } from "@/lib/server/gmail-benchmark";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { serializeScanProgress } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export async function POST() {
  try {
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Connect Gmail before scanning." }, { status: 401 });

    const activeConnection = await getActiveGmailConnection(session.userId, session.providerConnectionId);
    if (!activeConnection) return Response.json({ error: "Connect Gmail before scanning." }, { status: 401 });

    const accepted = await createGmailScanSession({
      userId: session.userId,
      providerConnectionId: activeConnection.connection.id
    });

    return Response.json({ progress: serializeScanProgress(accepted.progress), reused: accepted.reused });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Gmail scan could not be started." }, { status: 403 });
  }
}
