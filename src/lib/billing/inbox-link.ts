import "server-only";
import { prisma } from "@/lib/server/db";
import { BillingError } from "@/lib/billing/config";

export async function completeInboxLink(intentId: string, targetUserId: string, provider: "gmail" | "microsoft") {
  await prisma.$transaction(async (tx) => {
    const intent = await tx.inboxLinkIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.provider !== provider || intent.consumedAt || intent.expiresAt.getTime() <= Date.now()) throw new BillingError("Inbox linking expired. Start again from Account.", 409);
    const source = await tx.providerConnection.count({ where: { id: intent.sourceConnectionId, userId: intent.sourceUserId,
      sessionGeneration: intent.sourceGeneration, disconnectedAt: null, encryptedAccessToken: { not: null } } });
    if (source !== 1) throw new BillingError("Sign in to your original inbox and start linking again.", 409);
    const sourceUser = await tx.user.findUniqueOrThrow({ where: { id: intent.sourceUserId } });
    const owner = sourceUser.creditOwnerId ?? sourceUser.id;
    const target = await tx.user.findUniqueOrThrow({ where: { id: targetUserId }, include: { billingAccount: true } });
    if ((target.creditOwnerId ?? target.id) !== owner) {
      if (target.creditOwnerId || target.billingAccount ||
          await tx.user.count({ where: { creditOwnerId: target.id } }) || await tx.creditPurchase.count({ where: { userId: target.id } }) ||
          await tx.creditJobAccounting.count({ where: { userId: target.id } }) || await tx.cleanupJobState.count({ where: { userId: target.id } })) {
        throw new BillingError("This inbox already has a separate credit account or cleanup. Contact support before linking.", 409);
      }
      // The unique billing row also fences a concurrent first checkout for this identity.
      await tx.billingAccount.create({ data: { userId: target.id } });
      await tx.user.update({ where: { id: target.id }, data: { creditOwnerId: owner } });
    }
    const consumed = await tx.inboxLinkIntent.updateMany({ where: { id: intent.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    if (consumed.count !== 1) throw new BillingError("Inbox linking changed. Start again from Account.", 409);
  }, { isolationLevel: "Serializable" });
}
