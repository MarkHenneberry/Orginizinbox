import "server-only";
import { Prisma } from "@prisma/client";
import { decryptSecret } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import { clearGmailCleanupJobsForUser } from "@/lib/server/gmail-cleanup-store";
import { clearGmailScalableCleanupJobsForUser } from "@/lib/server/gmail-scalable-cleanup-store";
import {
  clearDurableProviderCleanupStateForUser
} from "@/lib/server/gmail-scalable-cleanup-durable-store";
import { revokeGoogleToken } from "@/lib/server/google-oauth";
import { clearLiveScan } from "@/lib/server/live-scan-store";
import { clearOAuthStateCookie, clearSessionCookie, getSession } from "@/lib/server/session";

export async function disconnectCurrentGmailSession() {
  return disconnectCurrentProviderSessionWithMode("local_disconnect", "gmail");
}

export async function disconnectCurrentProviderSession() {
  return disconnectCurrentProviderSessionWithMode("local_disconnect");
}

export async function removeCurrentGoogleAuthorization() {
  return disconnectCurrentProviderSessionWithMode("remote_revoke", "gmail");
}

type DisconnectMode = "local_disconnect" | "remote_revoke";

async function disconnectCurrentProviderSessionWithMode(
  mode: DisconnectMode,
  expectedProvider?: "gmail" | "microsoft"
) {
  await clearOAuthStateCookie();
  const session = await getSession();
  if (!session?.userId) {
    await clearSessionCookie();
    return disconnectResult(mode, undefined, false, false, null);
  }

  const connection = await prisma.providerConnection.findFirst({
    where: {
      ...(session.providerConnectionId ? { id: session.providerConnectionId } : {}),
      userId: session.userId,
      ...(expectedProvider ? { provider: expectedProvider } : {}),
      disconnectedAt: null
    },
    orderBy: {
      updatedAt: "desc"
    }
  });

  let revocationSucceeded = false;
  let revocationAttempted = false;
  let revocationStatus: number | null = null;
  if (connection) {
    const encryptedToken = connection.encryptedRefreshToken ?? connection.encryptedAccessToken;
    if (mode === "remote_revoke" && connection.provider === "gmail" && encryptedToken) {
      revocationAttempted = true;
      try {
        const revocation = await revokeGoogleToken(decryptSecret(encryptedToken));
        revocationSucceeded = revocation.succeeded;
        revocationStatus = revocation.status;
      } catch {
        revocationSucceeded = false;
      }
    }
    await prisma.providerConnection.update({
      where: { id: connection.id },
      data: {
        mailboxExternalIdHash: null,
        encryptedAccountEmail: null,
        encryptedAccessToken: null,
        encryptedRefreshToken: null,
        encryptedImapAccessToken: null,
        encryptedImapRefreshToken: null,
        imapTokenExpiresAt: null,
        imapScope: null,
        tokenExpiresAt: null,
        scope: null,
        tokenVersion: { increment: 1 },
        sessionGeneration: null,
        refreshLeaseOwner: null,
        refreshLeaseExpiresAt: null,
        disconnectedAt: new Date()
      }
    });
  }

  if (connection) {
    await clearLiveScan(session.userId, connection.provider);
  }
  if (connection?.provider === "gmail") {
    await clearGmailCleanupStateAfterDisconnect(session.userId);
  } else if (connection?.provider === "microsoft") {
    await prisma.cleanupJob.updateMany({
      where: { scan: { userId: session.userId, provider: "microsoft" }, status: { in: ["pending", "running"] } },
      data: { status: "cancelled", completedAt: new Date() }
    });
    await clearDurableProviderCleanupStateForUser(session.userId, "microsoft");
  }
  await clearSessionCookie();
  return disconnectResult(mode, connection?.provider, revocationAttempted, revocationSucceeded, revocationStatus);
}

export async function clearGmailCleanupStateAfterDisconnect(userId: string) {
  clearGmailCleanupJobsForUser(userId);
  clearGmailScalableCleanupJobsForUser(userId);
  await prisma.cleanupJob.updateMany({
    where: {
      scan: { userId, provider: "gmail" },
      status: { in: ["pending", "running"] }
    },
    data: { status: "cancelled", completedAt: new Date() }
  });
  await prisma.cleanupJob.updateMany({
    where: { scan: { userId, provider: "gmail" } },
    data: {
      terminalState: null,
      terminalSnapshot: Prisma.DbNull,
      terminalSnapshotVersion: 0
    }
  });
  await clearDurableProviderCleanupStateForUser(userId, "gmail");
}

function disconnectResult(
  mode: DisconnectMode,
  provider: "gmail" | "microsoft" | undefined,
  revocationAttempted: boolean,
  revocationSucceeded: boolean,
  revocationStatus: number | null
) {
  const result = {
    disconnected: true as const,
    mode,
    revocationAttempted,
    revocationSucceeded,
    revocationStatus
  };

  if (process.env.NODE_ENV !== "production") {
    console.info("Provider disconnect diagnostic", {
      provider: provider ?? "none",
      mode,
      remote_revocation_attempted: revocationAttempted,
      remote_revocation_status: revocationStatus,
      remote_revocation_succeeded: revocationSucceeded,
      local_cleanup_completed: true
    });
  }

  return result;
}
