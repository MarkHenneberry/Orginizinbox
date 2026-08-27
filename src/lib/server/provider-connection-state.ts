import "server-only";
import { runtimeConfig } from "@/lib/config";
import { hasRequiredGmailImapScope } from "@/lib/providers/gmail/scopes";
import { decryptSecret } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import { getSession } from "@/lib/server/session";

export type CurrentProviderConnection =
  | {
      mode: "fixture";
      userId?: string;
    }
  | {
      mode: "none";
      userId?: string;
    }
  | {
      mode: "connected";
      userId: string;
      providerConnectionId: string;
      provider: "gmail";
      accountEmail?: string;
      scope?: string | null;
      status: "connected";
    }
  | {
      mode: "needs_reconnect";
      userId: string;
      provider: "gmail";
      reason: string;
    };

export async function getCurrentProviderConnection(): Promise<CurrentProviderConnection> {
  const session = await getSession();
  if (!session?.userId) {
    if (runtimeConfig.fixtureMode) {
      return { mode: "fixture" };
    }
    return { mode: "none" };
  }

  const connection = await prisma.providerConnection.findFirst({
    where: {
      ...(session.providerConnectionId ? { id: session.providerConnectionId } : {}),
      userId: session.userId,
      provider: "gmail",
      disconnectedAt: null
    },
    orderBy: {
      updatedAt: "desc"
    }
  });

  if (!connection?.encryptedAccessToken || !connection.encryptedAccountEmail) {
    if (runtimeConfig.fixtureMode) {
      return { mode: "fixture", userId: session.userId };
    }
    return { mode: "none", userId: session.userId };
  }

  if (!hasRequiredGmailImapScope(connection.scope ?? undefined)) {
    return {
      mode: "needs_reconnect",
      userId: session.userId,
      provider: "gmail",
      reason: "Gmail needs to reconnect. Try again and approve Gmail access when Google asks."
    };
  }

  return {
    mode: "connected",
    userId: session.userId,
    providerConnectionId: connection.id,
    provider: "gmail",
    accountEmail: decryptSecret(connection.encryptedAccountEmail),
    scope: connection.scope,
    status: "connected"
  };
}
