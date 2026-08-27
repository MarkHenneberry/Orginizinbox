import { createGmailScanSession } from "@/lib/server/gmail-benchmark";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { clearLiveScan, reuseRunningLiveScan, serializeScanProgress } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export async function POST() {
  try {
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Connect Gmail before scanning." }, { status: 401 });

    const activeConnection = await getActiveGmailConnection(session.userId, session.providerConnectionId);
    if (!activeConnection) return Response.json({ error: "Connect Gmail before scanning." }, { status: 401 });

    const running = reuseRunningLiveScan(session.userId);
    if (running) return Response.json({ progress: serializeScanProgress(running.progress), reused: true });

    clearLiveScan(session.userId);
    const progress = createGmailScanSession({
      userId: session.userId,
      providerConnectionId: session.providerConnectionId
    });

    return Response.json({ progress: serializeScanProgress(progress) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Gmail scan could not be started." }, { status: 403 });
  }
}
