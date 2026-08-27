import { NextRequest, NextResponse } from "next/server";
import {
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  GmailImapScopeNotGrantedError,
  GoogleImapAuthenticationDeniedError,
  GoogleTokenExchangeError,
  GoogleTokenScopeVerificationError,
  hasRequiredGmailImapScope,
  verifyGoogleTokenScopes,
  upsertGoogleConnection
} from "@/lib/server/google-oauth";
import {
  createOAuthCallbackDiagnostic,
  logOAuthCallbackDiagnostic,
  safeOAuthDevelopmentErrorCodes,
  type OAuthCallbackDiagnostic,
  type SafeOAuthErrorReason
} from "@/lib/server/oauth-callback-diagnostics";
import { consumeOAuthState, setSessionCookie } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const diagnostic = createOAuthCallbackDiagnostic();
  let stateResult: Awaited<ReturnType<typeof consumeOAuthState>>;
  try {
    stateResult = await consumeOAuthState(request.nextUrl.searchParams.get("state"));
  } catch {
    diagnostic.state_validation = "failure";
    return errorRedirect(request, diagnostic, "callback_failed");
  }

  if (!stateResult.ok) {
    diagnostic.state_validation = "failure";
    return errorRedirect(request, diagnostic, oauthReasonCode(stateResult.reason));
  }
  diagnostic.state_validation = "success";

  if (request.nextUrl.searchParams.get("error")) {
    return errorRedirect(request, diagnostic, "oauth_denied");
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return errorRedirect(request, diagnostic, "missing_code");
  }

  let tokens: Awaited<ReturnType<typeof exchangeGoogleCode>>;
  try {
    tokens = await exchangeGoogleCode(code);
    diagnostic.token_exchange = "success";
  } catch (error) {
    diagnostic.token_exchange = "failure";
    return errorRedirect(request, diagnostic, error instanceof GoogleTokenExchangeError ? "token_exchange_failed" : "callback_failed");
  }

  diagnostic.token_scope_field_present = typeof tokens.scope === "string";
  diagnostic.explicit_scope_check = typeof tokens.scope === "string"
    ? hasRequiredGmailImapScope(tokens.scope) ? "present" : "missing"
    : "not_applicable";

  let profile: Awaited<ReturnType<typeof fetchGoogleUserInfo>> | undefined;
  if (typeof tokens.scope !== "string") {
    try {
      profile = await fetchGoogleUserInfo(tokens.access_token);
      if (!profile.email) throw new Error("Google userinfo did not include email.");
      diagnostic.userinfo = "success";
      diagnostic.fallback_scope_verification_started = true;
    } catch {
      diagnostic.userinfo = "failure";
      return errorRedirect(request, diagnostic, "userinfo_failed");
    }
  }

  let verifiedTokens: Awaited<ReturnType<typeof verifyGoogleTokenScopes>>;
  try {
    verifiedTokens = await verifyGoogleTokenScopes(tokens, profile?.email);
    applyScopeVerification(diagnostic, verifiedTokens.scopeVerification);
  } catch (error) {
    if (error instanceof GmailImapScopeNotGrantedError) {
      applyScopeVerification(diagnostic, error.verification);
      return errorRedirect(request, diagnostic, "gmail_scope");
    }
    if (error instanceof GoogleImapAuthenticationDeniedError) {
      applyScopeVerification(diagnostic, error.verification);
      return errorRedirect(request, diagnostic, "gmail_capability_denied");
    }
    if (error instanceof GoogleTokenScopeVerificationError) {
      applyScopeVerification(diagnostic, error.verification);
      return errorRedirect(request, diagnostic, "scope_verification_failed");
    }
    return errorRedirect(request, diagnostic, "callback_failed");
  }

  if (!profile) {
    try {
      profile = await fetchGoogleUserInfo(verifiedTokens.access_token);
      if (!profile.email) throw new Error("Google userinfo did not include email.");
      diagnostic.userinfo = "success";
    } catch {
      diagnostic.userinfo = "failure";
      return errorRedirect(request, diagnostic, "userinfo_failed");
    }
  }

  let savedConnection: Awaited<ReturnType<typeof upsertGoogleConnection>>;
  try {
    savedConnection = await upsertGoogleConnection(verifiedTokens, profile);
    diagnostic.provider_connection_save = "success";
  } catch {
    diagnostic.provider_connection_save = "failure";
    return errorRedirect(request, diagnostic, "provider_connection_save_failed");
  }

  try {
    await setSessionCookie({
      userId: savedConnection.user.id,
      providerConnectionId: savedConnection.connection.id,
      createdAt: Date.now()
    });
    diagnostic.session_creation = "success";
  } catch {
    diagnostic.session_creation = "failure";
    return errorRedirect(request, diagnostic, "session_creation_failed");
  }

  diagnostic.final_result = "success";
  logOAuthCallbackDiagnostic(diagnostic);
  return noStoreRedirect(new URL(stateResult.returnTo ?? "/app", request.url));
}

function noStoreRedirect(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

function errorRedirect(request: NextRequest, diagnostic: OAuthCallbackDiagnostic, reason: SafeOAuthErrorReason) {
  diagnostic.final_result = safeOAuthDevelopmentErrorCodes[reason];
  logOAuthCallbackDiagnostic(diagnostic);
  return noStoreRedirect(new URL(`/connect/google/error?reason=${reason}`, request.url));
}

function applyScopeVerification(
  diagnostic: OAuthCallbackDiagnostic,
  verification: Awaited<ReturnType<typeof verifyGoogleTokenScopes>>["scopeVerification"]
) {
  if (verification.source === "explicit") return;
  diagnostic.fallback_scope_verification_result = verification.result;
  diagnostic.fallback_attempts = verification.attempts;
  diagnostic.fallback_error_class = verification.errorClass;
  diagnostic.fallback_timeout = verification.timeout;
}

function oauthReasonCode(reason: string): SafeOAuthErrorReason {
  if (/Missing OAuth state cookie/i.test(reason)) return "missing_state_cookie";
  if (/Missing OAuth state/i.test(reason)) return "missing_state";
  if (/mismatch/i.test(reason)) return "state_mismatch";
  if (/expired/i.test(reason)) return "state_expired";
  return "state_invalid";
}
