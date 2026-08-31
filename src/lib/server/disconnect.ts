import "server-only";
import { Prisma } from "@prisma/client";
import { decryptSecret } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";
import { clearGmailCleanupJobsForUser } from "@/lib/server/gmail-cleanup-store";
import { clearGmailScalableCleanupJobsForUser } from "@/lib/server/gmail-scalable-cleanup-store";
import { clearDurableGmailScalableCleanupStateForUser } from "@/lib/server/gmail-scalable-cleanup-durable-store";
import { revokeGoogleToken } from "@/lib/server/google-oauth";
import { clearLiveScan } from "@/lib/server/live-scan-store";
import { clearOAuthStateCookie, clearSessionCookie, getSession } from "@/lib/server/session";

export async function disconnectCurrentGmailSession() {
  return disconnectCurrentGmailSessionWithMode("local_disconnect");
}

export async function removeCurrentGoogleAuthorization() {
  return disconnectCurrentGmailSessionWithMode("remote_revoke");
}

type DisconnectMode = "local_disconnect" | "remote_revoke";

async function disconnectCurrentGmailSessionWithMode(mode: DisconnectMode) {
  await clearOAuthStateCookie();
  const session = await getSession();
  if (!session?.userId) {
    await clearSessionCookie();
    return disconnectResult(mode, false, false, null);
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

  let revocationSucceeded = false;
  let revocationAttempted = false;
  let revocationStatus: number | null = null;
  if (connection) {
    const encryptedToken = connection.encryptedRefreshToken ?? connection.encryptedAccessToken;
    if (mode === "remote_revoke" && encryptedToken) {
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
        tokenExpiresAt: null,
        scope: null,
        disconnectedAt: new Date()
      }
    });
  }

  clearLiveScan(session.userId);
  await clearGmailCleanupStateAfterDisconnect(session.userId);
  await clearSessionCookie();
  return disconnectResult(mode, revocationAttempted, revocationSucceeded, revocationStatus);
}

export async function clearGmailCleanupStateAfterDisconnect(userId: string) {
  clearGmailCleanupJobsForUser(userId);
  clearGmailScalableCleanupJobsForUser(userId);
  await prisma.cleanupJob.updateMany({
    where: {
      scan: { userId },
      status: { in: ["pending", "running"] }
    },
    data: { status: "cancelled", completedAt: new Date() }
  });
  await prisma.cleanupJob.updateMany({
    where: { scan: { userId } },
    data: {
      terminalState: null,
      terminalSnapshot: Prisma.DbNull,
      terminalSnapshotVersion: 0
    }
  });
  await clearDurableGmailScalableCleanupStateForUser(userId);
}

function disconnectResult(mode: DisconnectMode, revocationAttempted: boolean, revocationSucceeded: boolean, revocationStatus: number | null) {
  const result = {
    disconnected: true as const,
    mode,
    revocationAttempted,
    revocationSucceeded,
    revocationStatus
  };

  if (process.env.NODE_ENV !== "production") {
    console.info("Gmail disconnect diagnostic", {
      mode,
      remote_revocation_attempted: revocationAttempted,
      remote_revocation_status: revocationStatus,
      remote_revocation_succeeded: revocationSucceeded,
      local_cleanup_completed: true
    });
  }

  return result;
}
