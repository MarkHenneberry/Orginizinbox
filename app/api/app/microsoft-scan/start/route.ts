import { NextRequest } from "next/server";
import { runtimeConfig } from "@/lib/config";
import { createMicrosoftScanSession } from "@/lib/server/microsoft-scan";
import {
  getActiveMicrosoftConnection,
  getActiveMicrosoftImapConnection
} from "@/lib/server/microsoft-connection";
import { serializeScanProgress } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export async function POST(request?: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.userId) return Response.json({ error: "Connect Microsoft before scanning Outlook." }, { status: 401 });

    const activeConnection = await getActiveMicrosoftConnection(session.userId, session.providerConnectionId);
    if (!activeConnection) return Response.json({ error: "Connect Microsoft before scanning Outlook." }, { status: 401 });
    const body = request
      ? await request.json().catch(() => ({})) as { transport?: unknown }
      : {};
    const transport = body.transport === "imap" ? "imap" : "graph";
    if (transport === "imap") {
      if (process.env.NODE_ENV === "production" || !runtimeConfig.outlookImapBenchmarkDevEnabled) {
        return Response.json({ error: "Outlook IMAP benchmark is not enabled." }, { status: 404 });
      }
      await getActiveMicrosoftImapConnection(session.userId, activeConnection.connection.id);
    }

    const accepted = await createMicrosoftScanSession({
      userId: session.userId,
      providerConnectionId: activeConnection.connection.id,
      transport
    });
    return Response.json({ progress: serializeScanProgress(accepted.progress), reused: accepted.reused });
  } catch {
    return Response.json({ error: "Microsoft needs to reconnect before Outlook can be scanned." }, { status: 403 });
  }
}
