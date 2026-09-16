import "server-only";
import type { Prisma } from "@prisma/client";
import { BillingError } from "@/lib/billing/config";

type Database = Pick<Prisma.TransactionClient, "user" | "billingAccount" | "creditJobAccounting" | "creditEntry">;

export async function creditOwner(db: Pick<Database, "user">, userId: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { creditOwnerId: true } });
  return user.creditOwnerId ?? userId;
}

export async function creditSnapshot(db: Database, userId: string) {
  const owner = await creditOwner(db, userId);
  const account = await db.billingAccount.findUnique({ where: { userId: owner } });
  const holds = await db.creditJobAccounting.findMany({
    where: { userId: owner, closed: false, activeStateJobId: { not: null } }, select: { requested: true, moved: true }
  });
  const reserved = holds.reduce((sum, hold) => sum + hold.requested - hold.moved, 0);
  const balance = account?.creditBalance ?? 0;
  return { balance, reserved, available: Math.max(0, balance - reserved) };
}

export type VerifiedCreditProgress = { requested: number; moved: number; restored: number; closed: boolean };
export function validateCreditProgress(progress: VerifiedCreditProgress) {
  if (![progress.requested, progress.moved, progress.restored].every(Number.isSafeInteger) ||
      progress.requested < 1 || progress.moved < 0 || progress.restored < 0 ||
      progress.moved > progress.requested || progress.restored > progress.moved) {
    throw new BillingError("Cleanup credit accounting could not be verified.");
  }
}

// Runs INSIDE the accepted encrypted job CAS transaction, never after mutation in a separate commit.
export async function accountVerifiedProgress(tx: Prisma.TransactionClient, userId: string, jobId: string, progress: VerifiedCreditProgress) {
  validateCreditProgress(progress);
  const owner = await creditOwner(tx, userId);
  const account = await tx.billingAccount.update({ where: { userId: owner }, data: { creditVersion: { increment: 1 } } });
  let prior = await tx.creditJobAccounting.findUnique({ where: { jobId } });
  if (!prior) {
    if (progress.moved || progress.restored) throw new BillingError("Cleanup credits must be reserved before moving messages.");
    const snapshot = await creditSnapshot(tx, owner);
    if (snapshot.available < progress.requested) throw new BillingError("Not enough available credits for this selection. Buy credits or select fewer messages.", 402);
    prior = await tx.creditJobAccounting.create({ data: { jobId, userId: owner, activeStateJobId: jobId, requested: progress.requested } });
  }
  if (prior.userId !== owner || prior.requested !== progress.requested || prior.activeStateJobId !== jobId ||
      progress.moved < prior.moved || progress.restored < prior.restored || (prior.closed && progress.moved !== prior.moved)) {
    throw new BillingError("Cleanup credit accounting changed. Recovery is still available.");
  }
  const amount = progress.restored - prior.restored - (progress.moved - prior.moved);
  if (progress.moved !== prior.moved || progress.restored !== prior.restored) {
    await tx.creditEntry.create({ data: { key: `job:${jobId}:${progress.moved}:${progress.restored}`, userId: owner, amount, kind: "verified_cleanup" } });
    await tx.billingAccount.update({ where: { userId: owner }, data: { creditBalance: account.creditBalance + amount } });
  }
  await tx.creditJobAccounting.update({ where: { jobId }, data: {
    moved: progress.moved, restored: progress.restored, closed: prior.closed || progress.closed
  } });
}
