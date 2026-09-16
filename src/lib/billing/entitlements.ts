import "server-only";
import type { BillingAccount } from "@prisma/client";
import { prisma } from "@/lib/server/db";
import { BillingError, getBillingConfig } from "@/lib/billing/config";
import { creditOwner, creditSnapshot } from "@/lib/billing/credits";
import { billingOperation } from "@/lib/billing/operations";
import { StripeBillingService } from "@/lib/billing/service";
import { createStripeClient } from "@/lib/billing/stripe";

type Balance = { balance: number; reserved: number; available: number };
export type Entitlement = Balance & { state: "free" | "active" | "inactive"; paidAccess: boolean; periodEnd: null };
const empty = { balance: 0, reserved: 0, available: 0 };
export function deriveEntitlement(account: BillingAccount | null, livemode: boolean, balance: Balance = empty): Entitlement {
  const valid = !account || account.livemode === livemode;
  return { ...balance, state: !valid || balance.balance < 0 ? "inactive" : balance.available > 0 ? "active" : "free",
    paidAccess: valid && balance.available > 0, periodEnd: null };
}

export async function getUserEntitlement(userId: string): Promise<Entitlement> {
  const config = getBillingConfig();
  if (!config) return { ...empty, state: "inactive", paidAccess: false, periodEnd: null };
  const owner = await creditOwner(prisma, userId);
  const account = await new StripeBillingService(prisma, createStripeClient(), config).reconcile(owner);
  return deriveEntitlement(account, config.livemode, await creditSnapshot(prisma, owner));
}

export class EntitlementDeniedError extends BillingError {
  constructor(readonly action: "upgrade" | "manage") {
    super(action === "upgrade" ? "Available cleanup credits are required. Open Account to buy credits."
      : "Your credit account needs attention. Open Account before starting cleanup.", 402);
  }
}

export async function requirePaidCleanupEntitlement(userId: string, jobId?: string) {
  try {
    const entitlement = await getUserEntitlement(userId);
    if (jobId && getBillingConfig()) {
      const held = await prisma.creditJobAccounting.findUnique({ where: { jobId } });
      const owner = await creditOwner(prisma, userId);
      // Existing funded jobs may finish verification even when their last credit was spent.
      if (held?.userId === owner && held.activeStateJobId === jobId && entitlement.state !== "inactive" && entitlement.balance >= entitlement.reserved) return entitlement;
    }
    if (!entitlement.paidAccess) throw new EntitlementDeniedError(entitlement.state === "free" ? "upgrade" : "manage");
    return entitlement;
  } catch (error) { billingOperation("entitlement_denied"); throw error; }
}
