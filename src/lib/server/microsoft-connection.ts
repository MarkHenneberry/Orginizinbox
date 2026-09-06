import "server-only";
import { randomUUID } from "node:crypto";
import {
  hasRequiredMicrosoftImapScope,
  hasRequiredMicrosoftMailScope
} from "@/lib/providers/microsoft/scopes";
import { decryptSecret, encryptSecret } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import {
  MicrosoftScopeNotGrantedError,
  MicrosoftTokenRefreshError,
  refreshMicrosoftAccessToken,
  refreshMicrosoftImapAccessToken
} from "@/lib/server/microsoft-oauth";
import { refreshProviderConnectionSingleFlight } from "@/lib/server/provider-token-refresh";

const refreshSkewMs = 60_000;

export async function getActiveMicrosoftConnection(userId: string, providerConnectionId?: string) {
  let connection = await prisma.providerConnection.findFirst({
    where: {
      ...(providerConnectionId ? { id: providerConnectionId } : {}),
      userId,
      provider: "microsoft",
      disconnectedAt: null
    }
  });
  if (!connection?.encryptedAccessToken || !connection.encryptedRefreshToken) return null;
  if (!hasRequiredMicrosoftMailScope(connection.scope)) throw new MicrosoftScopeNotGrantedError();

  if (connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() <= Date.now() + refreshSkewMs) {
    try {
      connection = await refreshProviderConnectionSingleFlight({
        userId,
        connection,
        provider: "microsoft",
        refreshSkewMs,
        async refresh(refreshToken) {
          const refreshed = await refreshMicrosoftAccessToken(refreshToken);
          if (!refreshed.access_token) throw new MicrosoftReconnectRequiredError();
          if (refreshed.scope && !hasRequiredMicrosoftMailScope(refreshed.scope)) throw new MicrosoftReconnectRequiredError();
          return {
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token,
            tokenExpiresAt: refreshed.expires_in
              ? new Date(Date.now() + refreshed.expires_in * 1000)
              : connection!.tokenExpiresAt,
            scope: refreshed.scope ?? connection!.scope
          };
        }
      });
    } catch {
      throw new MicrosoftReconnectRequiredError();
    }
  }

  const accessToken = decryptSecret(connection.encryptedAccessToken!);
  const refreshToken = decryptSecret(connection.encryptedRefreshToken!);

  return {
    connection,
    accessToken,
    refreshToken,
    accountEmail: connection.encryptedAccountEmail
      ? decryptSecret(connection.encryptedAccountEmail)
      : undefined
  };
}

export async function forceRefreshMicrosoftConnection(userId: string, providerConnectionId?: string) {
  const connection = await prisma.providerConnection.findFirst({
    where: {
      ...(providerConnectionId ? { id: providerConnectionId } : {}),
      userId,
      provider: "microsoft",
      disconnectedAt: null
    }
  });
  if (!connection?.encryptedRefreshToken || !hasRequiredMicrosoftMailScope(connection.scope)) {
    throw new MicrosoftReconnectRequiredError();
  }

  let refreshedConnection;
  try {
    refreshedConnection = await refreshProviderConnectionSingleFlight({
      userId,
      connection,
      provider: "microsoft",
      force: true,
      refreshSkewMs,
      async refresh(refreshToken) {
        const refreshed = await refreshMicrosoftAccessToken(refreshToken);
        if (!refreshed.access_token || (refreshed.scope && !hasRequiredMicrosoftMailScope(refreshed.scope))) {
          throw new MicrosoftReconnectRequiredError();
        }
        return {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          tokenExpiresAt: refreshed.expires_in
            ? new Date(Date.now() + refreshed.expires_in * 1000)
            : connection.tokenExpiresAt,
          scope: refreshed.scope ?? connection.scope
        };
      }
    });
  } catch {
    throw new MicrosoftReconnectRequiredError();
  }
  return decryptSecret(refreshedConnection.encryptedAccessToken!);
}

export async function getActiveMicrosoftImapConnection(userId: string, providerConnectionId?: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const connection = await prisma.providerConnection.findFirst({
      where: {
        ...(providerConnectionId ? { id: providerConnectionId } : {}),
        userId,
        provider: "microsoft",
        disconnectedAt: null
      }
    });
    if (!connection?.encryptedImapAccessToken ||
        !connection.encryptedImapRefreshToken ||
        !connection.encryptedAccountEmail ||
        !hasRequiredMicrosoftImapScope(connection.imapScope)) {
      throw new MicrosoftImapReconnectRequiredError();
    }
    const refreshNeeded = !connection.imapTokenExpiresAt ||
      connection.imapTokenExpiresAt.getTime() <= Date.now() + refreshSkewMs;
    if (!refreshNeeded) return decryptImapConnection(connection);

    const owner = `imap-token-refresh:${randomUUID()}`;
    const now = new Date();
    const claim = await prisma.providerConnection.updateMany({
      where: {
        id: connection.id,
        userId,
        provider: "microsoft",
        tokenVersion: connection.tokenVersion,
        OR: [
          { refreshLeaseOwner: null },
          { refreshLeaseExpiresAt: null },
          { refreshLeaseExpiresAt: { lte: now } }
        ]
      },
      data: {
        refreshLeaseOwner: owner,
        refreshLeaseExpiresAt: new Date(now.getTime() + 30_000)
      }
    });
    if (claim.count !== 1) {
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
      continue;
    }

    try {
      const refreshed = await refreshMicrosoftImapAccessToken(
        decryptSecret(connection.encryptedImapRefreshToken)
      );
      if (!refreshed.access_token ||
          (refreshed.scope && !hasRequiredMicrosoftImapScope(refreshed.scope))) {
        throw new MicrosoftImapReconnectRequiredError();
      }
      const committed = await prisma.providerConnection.updateMany({
        where: {
          id: connection.id,
          userId,
          provider: "microsoft",
          tokenVersion: connection.tokenVersion,
          refreshLeaseOwner: owner,
          refreshLeaseExpiresAt: { gt: new Date() }
        },
        data: {
          encryptedImapAccessToken: encryptSecret(refreshed.access_token),
          encryptedImapRefreshToken: encryptSecret(
            refreshed.refresh_token ?? decryptSecret(connection.encryptedImapRefreshToken)
          ),
          imapTokenExpiresAt: refreshed.expires_in
            ? new Date(Date.now() + refreshed.expires_in * 1000)
            : connection.imapTokenExpiresAt,
          imapScope: refreshed.scope ?? connection.imapScope,
          tokenVersion: { increment: 1 },
          refreshLeaseOwner: null,
          refreshLeaseExpiresAt: null
        }
      });
      if (committed.count !== 1) throw new MicrosoftImapReconnectRequiredError();
    } catch (error) {
      await prisma.providerConnection.updateMany({
        where: { id: connection.id, refreshLeaseOwner: owner },
        data: { refreshLeaseOwner: null, refreshLeaseExpiresAt: null }
      });
      if (error instanceof MicrosoftImapReconnectRequiredError) throw error;
      throw new MicrosoftImapReconnectRequiredError();
    }
  }
  throw new MicrosoftImapReconnectRequiredError();
}

function decryptImapConnection(connection: Awaited<ReturnType<typeof prisma.providerConnection.findFirst>> & {}) {
  if (!connection?.encryptedImapAccessToken || !connection.encryptedAccountEmail) {
    throw new MicrosoftImapReconnectRequiredError();
  }
  return {
    connection,
    accessToken: decryptSecret(connection.encryptedImapAccessToken),
    accountEmail: decryptSecret(connection.encryptedAccountEmail)
  };
}

export class MicrosoftReconnectRequiredError extends MicrosoftTokenRefreshError {
  constructor() {
    super();
    this.name = "MicrosoftReconnectRequiredError";
  }
}

export class MicrosoftImapReconnectRequiredError extends MicrosoftTokenRefreshError {
  constructor() {
    super();
    this.name = "MicrosoftImapReconnectRequiredError";
    this.message = "Approve Outlook IMAP access before running the IMAP benchmark.";
  }
}
