import "server-only";
import { runtimeConfig } from "@/lib/config";
import { hasRequiredGmailImapScope } from "@/lib/providers/gmail/scopes";
import { hasRequiredMicrosoftMailScope } from "@/lib/providers/microsoft/scopes";
import { decryptSecret } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import { getActiveMicrosoftConnection } from "@/lib/server/microsoft-connection";
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
      provider: "gmail" | "microsoft";
      accountEmail?: string;
      scope?: string | null;
      imapScope?: string | null;
      status: "connected";
    }
  | {
      mode: "needs_reconnect";
      userId: string;
      provider: "gmail" | "microsoft";
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
      disconnectedAt: null
    },
    orderBy: {
      updatedAt: "desc"
    }
  });

  if (!connection?.encryptedAccessToken || (connection.provider === "gmail" && !connection.encryptedAccountEmail)) {
    if (runtimeConfig.fixtureMode) {
      return { mode: "fixture", userId: session.userId };
    }
    return { mode: "none", userId: session.userId };
  }

  if (connection.provider === "gmail" && !hasRequiredGmailImapScope(connection.scope ?? undefined)) {
    return {
      mode: "needs_reconnect",
      userId: session.userId,
      provider: "gmail",
      reason: "Gmail needs to reconnect. Try again and approve Gmail access when Google asks."
    };
  }

  if (connection.provider === "microsoft") {
    if (!connection.encryptedRefreshToken || !hasRequiredMicrosoftMailScope(connection.scope)) {
      return {
        mode: "needs_reconnect",
        userId: session.userId,
        provider: "microsoft",
        reason: "Microsoft needs to reconnect. Try again and approve Microsoft mail access."
      };
    }
    try {
      const active = await getActiveMicrosoftConnection(session.userId, connection.id);
      if (!active) throw new Error("Missing Microsoft credentials.");
      return {
        mode: "connected",
        userId: session.userId,
        providerConnectionId: connection.id,
        provider: "microsoft",
        accountEmail: active.accountEmail,
        scope: active.connection.scope,
        imapScope: active.connection.imapScope,
        status: "connected"
      };
    } catch {
      return {
        mode: "needs_reconnect",
        userId: session.userId,
        provider: "microsoft",
        reason: "Microsoft needs to reconnect. Try connecting Microsoft again."
      };
    }
  }

  return {
    mode: "connected",
    userId: session.userId,
    providerConnectionId: connection.id,
    provider: "gmail",
    accountEmail: decryptSecret(connection.encryptedAccountEmail ?? ""),
    scope: connection.scope,
    status: "connected"
  };
}
