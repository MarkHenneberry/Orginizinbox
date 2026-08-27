import { env, pricingConfig } from "@/lib/config";

export async function createFullResetCheckoutSession() {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_FULL_RESET_USD) {
    return {
      ok: false as const,
      reason: "Stripe checkout is not configured. Add STRIPE_SECRET_KEY and STRIPE_PRICE_FULL_RESET_USD."
    };
  }

  return {
    ok: false as const,
    reason: `${pricingConfig.fullReset.label} checkout boundary is prepared, but live Stripe session creation is not implemented yet.`
  };
}
