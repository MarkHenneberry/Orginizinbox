import "server-only";
import { decryptSecret } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import { gmailMissingImapScopeMessage, hasRequiredGmailImapScope, refreshGoogleAccessToken } from "@/lib/server/google-oauth";
import { refreshProviderConnectionSingleFlight } from "@/lib/server/provider-token-refresh";

const refreshSkewMs = 60 * 1000;

export async function getActiveGmailConnection(userId: string, providerConnectionId?: string) {
  let connection = await prisma.providerConnection.findFirst({
    where: {
      id: providerConnectionId,
      userId,
      provider: "gmail",
      disconnectedAt: null
    }
  });

  if (!connection?.encryptedAccessToken || !connection.encryptedAccountEmail) {
    return null;
  }
  if (!hasRequiredGmailImapScope(connection.scope ?? undefined)) {
    throw new Error(gmailMissingImapScopeMessage);
  }

  if (connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() <= Date.now() + refreshSkewMs) {
    if (!connection.encryptedRefreshToken) {
      throw new Error("Gmail access token is expired and no refresh token is available.");
    }
    connection = await refreshProviderConnectionSingleFlight({
      userId,
      connection,
      provider: "gmail",
      refreshSkewMs,
      async refresh(refreshToken) {
        const refreshed = await refreshGoogleAccessToken(refreshToken);
        if (!refreshed.access_token) throw new Error("Google token refresh did not return an access token.");
        if (refreshed.scope && !hasRequiredGmailImapScope(refreshed.scope)) throw new Error(gmailMissingImapScopeMessage);
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

  const accessToken = decryptSecret(connection.encryptedAccessToken!);
  const accountEmail = decryptSecret(connection.encryptedAccountEmail!);

  return {
    connection,
    accessToken,
    accountEmail,
    refreshToken: connection.encryptedRefreshToken ? decryptSecret(connection.encryptedRefreshToken) : undefined
  };
}
