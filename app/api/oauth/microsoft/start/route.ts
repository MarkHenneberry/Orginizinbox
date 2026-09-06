import { NextResponse } from "next/server";
import { ConfigurationError, requireMicrosoftOAuthConfig, runtimeConfig } from "@/lib/config";
import {
  buildMicrosoftAuthorizationUrl,
  createMicrosoftOAuthAttemptSecrets
} from "@/lib/server/microsoft-oauth";
import { createOAuthState } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    if (process.env.NODE_ENV === "production" || !runtimeConfig.microsoftOAuthDevEnabled) {
      return Response.json({ error: "Microsoft OAuth is not enabled for normal product navigation." }, { status: 404 });
    }
    requireMicrosoftOAuthConfig();
    const attempt = createMicrosoftOAuthAttemptSecrets();
    const state = await createOAuthState("/app/account", {
      provider: "microsoft",
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      microsoftFlow: "graph"
    });
    const response = NextResponse.redirect(buildMicrosoftAuthorizationUrl({
      state,
      codeChallenge: attempt.codeChallenge,
      nonce: attempt.nonce,
      flow: "graph"
    }));
    response.headers.set("Cache-Control", "no-store, max-age=0");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return Response.json({ error: error.message }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
    }
    return Response.json({ error: "Microsoft OAuth could not be started." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
