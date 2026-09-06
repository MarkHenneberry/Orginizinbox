import { NextRequest, NextResponse } from "next/server";
import { runtimeConfig } from "@/lib/config";
import {
  exchangeMicrosoftCode,
  MicrosoftImapScopeNotGrantedError,
  MicrosoftIdentityValidationError,
  MicrosoftRefreshTokenMissingError,
  MicrosoftScopeNotGrantedError,
  MicrosoftTokenResponseError,
  saveMicrosoftImapCredentials,
  upsertMicrosoftConnection,
  verifyMicrosoftImapTokenResponse,
  verifyMicrosoftTokenResponse
} from "@/lib/server/microsoft-oauth";
import { consumeOAuthState, getSession, setSessionCookie } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type MicrosoftCallbackReason =
  | "oauth_denied"
  | "missing_code"
  | "state_invalid"
  | "token_exchange_failed"
  | "scope_missing"
  | "imap_scope_missing"
  | "refresh_token_missing"
  | "identity_failed"
  | "connection_save_failed"
  | "session_failed";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production" || !runtimeConfig.microsoftOAuthDevEnabled) {
    return Response.json({ error: "Microsoft OAuth is not enabled." }, { status: 404 });
  }
  let stateResult: Awaited<ReturnType<typeof consumeOAuthState>>;
  try {
    stateResult = await consumeOAuthState(request.nextUrl.searchParams.get("state"), "microsoft");
  } catch {
    return errorRedirect(request, "state_invalid");
  }
  if (!stateResult.ok || !stateResult.codeVerifier || !stateResult.nonce) return errorRedirect(request, "state_invalid");
  if (request.nextUrl.searchParams.get("error")) return errorRedirect(request, "oauth_denied");
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return errorRedirect(request, "missing_code");

  let tokens: Awaited<ReturnType<typeof exchangeMicrosoftCode>>;
  try {
    tokens = await exchangeMicrosoftCode(
      code,
      stateResult.codeVerifier,
      stateResult.microsoftFlow === "imap" ? "imap" : "graph"
    );
  } catch {
    return errorRedirect(request, "token_exchange_failed");
  }

  let verified: Awaited<ReturnType<typeof verifyMicrosoftTokenResponse>>;
  try {
    verified = stateResult.microsoftFlow === "imap"
      ? await verifyMicrosoftImapTokenResponse(tokens, stateResult.nonce)
      : await verifyMicrosoftTokenResponse(tokens, stateResult.nonce);
  } catch (error) {
    if (error instanceof MicrosoftImapScopeNotGrantedError) return errorRedirect(request, "imap_scope_missing");
    if (error instanceof MicrosoftScopeNotGrantedError) return errorRedirect(request, "scope_missing");
    if (error instanceof MicrosoftRefreshTokenMissingError) return errorRedirect(request, "refresh_token_missing");
    if (error instanceof MicrosoftTokenResponseError) return errorRedirect(request, "token_exchange_failed");
    if (error instanceof MicrosoftIdentityValidationError) return errorRedirect(request, "identity_failed");
    return errorRedirect(request, "identity_failed");
  }

  if (stateResult.microsoftFlow === "imap") {
    const session = await getSession();
    if (!session?.userId || !session.providerConnectionId) return errorRedirect(request, "session_failed");
    try {
      await saveMicrosoftImapCredentials({
        userId: session.userId,
        providerConnectionId: session.providerConnectionId,
        tokens: verified
      });
    } catch {
      return errorRedirect(request, "identity_failed");
    }
    logSafeMicrosoftCallback("success");
    return noStoreRedirect(new URL(stateResult.returnTo ?? "/app/scan", request.url));
  }

  let saved: Awaited<ReturnType<typeof upsertMicrosoftConnection>>;
  try {
    saved = await upsertMicrosoftConnection(verified);
  } catch {
    return errorRedirect(request, "connection_save_failed");
  }
  try {
    await setSessionCookie({
      userId: saved.user.id,
      providerConnectionId: saved.connection.id,
      createdAt: Date.now()
    });
  } catch {
    return errorRedirect(request, "session_failed");
  }
  logSafeMicrosoftCallback("success");
  return noStoreRedirect(new URL(stateResult.returnTo ?? "/app/account", request.url));
}

function errorRedirect(request: NextRequest, reason: MicrosoftCallbackReason) {
  logSafeMicrosoftCallback(reason);
  return noStoreRedirect(new URL(`/connect/microsoft?reason=${reason}`, request.url));
}

function noStoreRedirect(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function logSafeMicrosoftCallback(result: MicrosoftCallbackReason | "success") {
  if (process.env.NODE_ENV !== "production") {
    console.info("Microsoft OAuth callback diagnostic", { result });
  }
}
