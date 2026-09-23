import "server-only";
import { runtimeConfig } from "@/lib/config";
import { decryptSecret } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import { gmailMissingImapScopeMessage, hasRequiredGmailImapScope, refreshGoogleAccessToken } from "@/lib/server/google-oauth";
import { refreshProviderConnectionSingleFlight } from "@/lib/server/provider-token-refresh";
import type { GmailConnectionDiagnostic, GmailConnectionFailureReason } from "@/lib/server/gmail-scan-failure";

const refreshSkewMs = 60 * 1000;

export async function getActiveGmailConnection(userId: string, providerConnectionId?: string, diagnostic?: GmailConnectionDiagnostic) {
  // Request-local instrumentation only. Preserve the original result or thrown error.
  const stage: { reason: GmailConnectionFailureReason } = { reason: "unknown_connection_failure" };
  if (diagnostic) delete diagnostic.failureReason;
  try {
    const result = await resolveActiveGmailConnection(userId, providerConnectionId, stage);
    if (!result && diagnostic) diagnostic.failureReason = stage.reason;
    return result;
  } catch (error) {
    if (diagnostic) diagnostic.failureReason = stage.reason;
    throw error;
  }
}

async function resolveActiveGmailConnection(userId: string, providerConnectionId: string | undefined, stage: { reason: GmailConnectionFailureReason }) {
  if (process.env.NODE_ENV === "production" && !runtimeConfig.gmailAvailable) {
    stage.reason = "runtime_config_unavailable";
    return null;
  }
  stage.reason = "connection_lookup_failed";
  let connection = await prisma.providerConnection.findFirst({
    where: {
      id: providerConnectionId,
      userId,
      provider: "gmail",
      disconnectedAt: null
    }
  });

  if (!connection) {
    stage.reason = "connection_record_missing";
    return null;
  }
  if (!connection.encryptedAccessToken || !connection.encryptedAccountEmail) {
    stage.reason = "connection_credentials_missing";
    return null;
  }
  stage.reason = "unknown_connection_failure";
  if (!hasRequiredGmailImapScope(connection.scope ?? undefined)) {
    stage.reason = "gmail_scope_missing";
    throw new Error(gmailMissingImapScopeMessage);
  }

  if (connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() <= Date.now() + refreshSkewMs) {
    if (!connection.encryptedRefreshToken) {
      stage.reason = "token_expired_no_refresh_token";
      throw new Error("Gmail access token is expired and no refresh token is available.");
    }
    stage.reason = "token_refresh_failed";
    connection = await refreshProviderConnectionSingleFlight({
      userId,
      connection,
      provider: "gmail",
      refreshSkewMs,
      async refresh(refreshToken) {
        const refreshed = await refreshGoogleAccessToken(refreshToken);
        if (!refreshed.access_token) {
          stage.reason = "token_refresh_access_token_missing";
          throw new Error("Google token refresh did not return an access token.");
        }
        if (refreshed.scope && !hasRequiredGmailImapScope(refreshed.scope)) {
          stage.reason = "token_refresh_scope_missing";
          throw new Error(gmailMissingImapScopeMessage);
        }
        return {
          accessToken: refreshed.access_token,
          tokenExpiresAt: refreshed.expires_in
            ? new Date(Date.now() + refreshed.expires_in * 1000)
            : connection!.tokenExpiresAt,
          scope: refreshed.scope ?? connection!.scope
        };
      }
    });
  }

  stage.reason = "access_token_decrypt_failed";
  const accessToken = decryptSecret(connection.encryptedAccessToken!);
  stage.reason = "account_email_decrypt_failed";
  const accountEmail = decryptSecret(connection.encryptedAccountEmail!);

  stage.reason = "refresh_token_decrypt_failed";
  return {
    connection,
    accessToken,
    accountEmail,
    refreshToken: connection.encryptedRefreshToken ? decryptSecret(connection.encryptedRefreshToken) : undefined
  };
}
