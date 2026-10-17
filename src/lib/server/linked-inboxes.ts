import "server-only";
import { cache } from "react";
import { Prisma, type ProviderConnection } from "@prisma/client";
import { runtimeConfig } from "@/lib/config";
import { creditOwner } from "@/lib/billing/credits";
import type { LinkedInbox } from "@/lib/domain/linked-inboxes";
import { hasRequiredGmailImapScope } from "@/lib/providers/gmail/scopes";
import { hasRequiredMicrosoftMailScope } from "@/lib/providers/microsoft/scopes";
import { decryptSecret } from "./crypto";
import { prisma } from "./db";
import { getLiveScan } from "./live-scan-store";
import { isLiveReportUsable } from "@/lib/domain/report-readiness";
import { appSessionCookieOptions, getSession, setSessionCookie } from "./session";

const select = {
  id: true, userId: true, provider: true, encryptedAccountEmail: true, encryptedAccessToken: true,
  encryptedRefreshToken: true, tokenExpiresAt: true, scope: true, disconnectedAt: true
} satisfies Prisma.ProviderConnectionSelect;
type Connection = Pick<ProviderConnection, keyof typeof select>;
type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;
const membership = (owner: string) => ({ OR: [{ id: owner }, { creditOwnerId: owner }] });

function presentation(row: Connection, activeId: string): LinkedInbox {
  let email: string | null = null;
  let usable = !row.disconnectedAt && Boolean(row.encryptedAccessToken);
  try {
    if (row.encryptedAccountEmail) email = decryptSecret(row.encryptedAccountEmail);
    if (row.encryptedAccessToken) usable &&= Boolean(decryptSecret(row.encryptedAccessToken));
    if (row.encryptedRefreshToken) usable &&= Boolean(decryptSecret(row.encryptedRefreshToken));
  } catch { usable = false; }
  usable &&= row.provider === "gmail"
    ? Boolean(email) && hasRequiredGmailImapScope(row.scope ?? undefined)
    : Boolean(row.encryptedRefreshToken) && hasRequiredMicrosoftMailScope(row.scope);
  if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= Date.now() + 60000 && !row.encryptedRefreshToken) usable = false;
  const available = row.provider === "gmail" ? runtimeConfig.gmailAvailable : runtimeConfig.microsoftAvailable;
  return { id: row.id, provider: row.provider, email, active: row.id === activeId,
    state: !available ? "unavailable" : usable ? "ready" : "needs_reconnect" };
}

// React cache is request-local; never share decrypted presentation across users.
export const getLinkedInboxes = cache(async (): Promise<LinkedInbox[]> => {
  const session = await getSession();
  if (!session) return [];
  const owner = await creditOwner(prisma, session.userId);
  const rows = await prisma.providerConnection.findMany({ where: { user: membership(owner) }, select, orderBy: { createdAt: "asc" } });
  return rows.map(row => presentation(row, session.providerConnectionId));
});

export class InboxSwitchError extends Error {
  constructor(readonly code: "unavailable" | "needs_reconnect" | "operation_active" | "unauthorized", readonly status: number) {
    super(code);
  }
}

async function authorizedTarget(tx: Prisma.TransactionClient, source: Session, targetId: string) {
  const now = Date.now();
  if (now < source.createdAt || now - source.createdAt >= appSessionCookieOptions().maxAge * 1000 ||
      !await tx.providerConnection.findFirst({ where: { id: source.providerConnectionId, userId: source.userId,
        sessionGeneration: source.sessionGeneration, disconnectedAt: null, encryptedAccessToken: { not: null } }, select: { id: true } })) {
    throw new InboxSwitchError("unauthorized", 401);
  }
  const owner = await creditOwner(tx, source.userId);
  const target = await tx.providerConnection.findFirst({ where: { id: targetId, user: membership(owner) }, select });
  if (!target) throw new InboxSwitchError("unauthorized", 403);
  const shown = presentation(target, source.providerConnectionId);
  if (shown.state !== "ready") throw new InboxSwitchError(shown.state, 409);
  return target;
}

export async function switchLinkedInbox(source: Session, targetId: string) {
  // Preflight obtains only a verified target identity. Repeat authorization inside activation.
  const target = await authorizedTarget(prisma, source, targetId);
  const report = await getLiveScan(target.userId, target.provider);
  const url = isLiveReportUsable(report) && report.progress.provider === target.provider ? "/app/report" : "/app/scan";
  if (target.id === source.providerConnectionId) return { url };
  await setSessionCookie({ userId: target.userId, providerConnectionId: target.id, createdAt: Date.now() }, async tx => {
    const current = await authorizedTarget(tx, source, targetId);
    if (current.userId !== target.userId) throw new InboxSwitchError("unauthorized", 403);
    // Acceptance upserts the scan before creating a job. Lock scans first, then existing
    // recovery rows, so neither new-job acceptance nor a lease claim crosses activation.
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "Scan"
      WHERE "userId" = ${target.userId} AND "providerConnectionId" = ${target.id} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "CleanupJobState" AS state
      JOIN "CleanupJob" AS job ON job.id = state."jobId"
      JOIN "Scan" AS scan ON scan.id = job."scanId"
      WHERE state."userId" = ${target.userId} AND scan."providerConnectionId" = ${target.id}
      FOR UPDATE OF state`);
    // Each durable execution unit claims its lease before loading the connection generation.
    // Idle review/recovery and gaps between units are safe; aggregate job status can lag.
    const busy = await tx.cleanupJobState.count({ where: { userId: target.userId,
      job: { scan: { providerConnectionId: target.id } },
      lockExpiresAt: { gt: new Date() }, lockOwner: { not: null } } });
    if (busy) throw new InboxSwitchError("operation_active", 409);
  });
  return { url };
}
