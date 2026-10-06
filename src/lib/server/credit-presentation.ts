import "server-only";
import { cache } from "react";
import { creditOwner, creditSnapshot } from "@/lib/billing/credits";
import { prisma } from "@/lib/server/db";
import { getSession } from "@/lib/server/session";

// Request-local deduplication only. Displaying a balance never calls Stripe.
export const getCreditPresentation = cache(async () => {
  try {
    const session = await getSession();
    if (!session) return null;
    return await creditSnapshot(prisma, session.userId);
  } catch { return null; }
});

export async function getLinkedInboxCount() {
  try {
    const session = await getSession();
    if (!session) return null;
    const owner = await creditOwner(prisma, session.userId);
    return 1 + await prisma.user.count({ where: { creditOwnerId: owner } });
  } catch { return null; }
}
