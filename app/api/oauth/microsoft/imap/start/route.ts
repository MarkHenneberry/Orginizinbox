import { NextResponse } from "next/server";
import { runtimeConfig } from "@/lib/config";
import {
  buildMicrosoftAuthorizationUrl,
  createMicrosoftOAuthAttemptSecrets
} from "@/lib/server/microsoft-oauth";
import { getActiveMicrosoftConnection } from "@/lib/server/microsoft-connection";
import { createOAuthState, getSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  if (process.env.NODE_ENV === "production" ||
      !runtimeConfig.microsoftOAuthDevEnabled ||
      !runtimeConfig.outlookImapBenchmarkDevEnabled) {
    return Response.json({ error: "Outlook IMAP benchmark consent is not enabled." }, { status: 404 });
  }
  const session = await getSession();
  if (!session?.userId || !session.providerConnectionId) {
    return Response.json({ error: "Connect Microsoft before enabling the IMAP benchmark." }, { status: 401 });
  }
  const connection = await getActiveMicrosoftConnection(session.userId, session.providerConnectionId);
  if (!connection) return Response.json({ error: "Reconnect Microsoft first." }, { status: 401 });

  const attempt = createMicrosoftOAuthAttemptSecrets();
  const state = await createOAuthState("/app/scan", {
    provider: "microsoft",
    codeVerifier: attempt.codeVerifier,
    nonce: attempt.nonce,
    microsoftFlow: "imap"
  });
  const response = NextResponse.redirect(buildMicrosoftAuthorizationUrl({
    state,
    codeChallenge: attempt.codeChallenge,
    nonce: attempt.nonce,
    flow: "imap"
  }));
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
