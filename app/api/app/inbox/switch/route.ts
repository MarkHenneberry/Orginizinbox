import { env } from "@/lib/config";
import { getSession } from "@/lib/server/session";
import { InboxSwitchError, switchLinkedInbox } from "@/lib/server/linked-inboxes";

const messages = {
  unauthorized: "This inbox is not available to your account. Return to Account and try again.",
  unavailable: "This provider is temporarily unavailable.",
  needs_reconnect: "This inbox needs to reconnect before you can switch to it.",
  operation_active: "Finish the target inbox operation before switching to it."
};
const headers = { "Cache-Control": "no-store" };
export async function POST(request: Request) {
  try {
    const origin = new URL(env.NEXT_PUBLIC_APP_URL).origin;
    if (request.headers.get("origin") !== origin || new URL(request.url).origin !== origin) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    const session = await getSession();
    if (!session) return Response.json({ error: "Sign in before switching inboxes." }, { status: 401, headers });
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || !("connectionId" in body) || typeof body.connectionId !== "string" || !body.connectionId || body.connectionId.length > 128) {
      return Response.json({ error: "Choose an inbox from Account." }, { status: 400, headers });
    }
    return Response.json(await switchLinkedInbox(session, body.connectionId), { headers });
  } catch (error) {
    if (error instanceof InboxSwitchError) return Response.json({ code: error.code, error: messages[error.code] }, { status: error.status, headers });
    return Response.json({ error: "Your inbox could not be switched. Try again from Account." }, { status: 503, headers });
  }
}
