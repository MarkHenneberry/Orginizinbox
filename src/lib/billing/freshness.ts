import "server-only";
import type { BillingAccount } from "@prisma/client";

export const billingFreshMs = 5 * 60_000;
export const billingRefreshMs = 60_000;

export function billingSnapshotFresh(account: Pick<BillingAccount, "syncedAt">, maxAge: number, now: number) {
  const syncedAt = account.syncedAt?.getTime();
  return syncedAt !== undefined && Number.isFinite(syncedAt) && syncedAt <= now && now - syncedAt < maxAge;
}
