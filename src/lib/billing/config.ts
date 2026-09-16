import "server-only";
import { creditPacks, type CreditPack } from "@/lib/billing/packs";

export const stripeApiVersion = "2026-08-26.dahlia" as const;

export function resolveBillingConfig(input: Record<string, string | undefined>) {
  const mode = input.STRIPE_BILLING_MODE ?? "test";
  if (mode !== "test" && mode !== "live") return null;
  const secretKey = input.STRIPE_SECRET_KEY ?? "";
  const webhookSecret = input.STRIPE_WEBHOOK_SECRET ?? "";
  const prices = Object.fromEntries(Object.entries(creditPacks).map(([key, pack]) => [key, input[pack.env] ?? ""])) as Record<CreditPack, string>;
  if (!new RegExp(`^sk_${mode}_[A-Za-z0-9]+$`).test(secretKey) ||
      !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret) || !Object.values(prices).every((id) => /^price_[A-Za-z0-9]+$/.test(id)) ||
      new Set(Object.values(prices)).size !== 3 || !input.DATABASE_URL) return null;
  try {
    const database = new URL(input.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:", "prisma:", "prisma+postgres:"].includes(database.protocol) || !database.hostname) return null;
    if (input.NODE_ENV === "production") {
      const key = input.TOKEN_ENCRYPTION_KEY ?? "";
      if (Buffer.from(key, "base64").length !== 32 && Buffer.byteLength(key) !== 32) return null;
    }
    const url = new URL(input.NEXT_PUBLIC_APP_URL ?? "");
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol !== "https:" && !(mode === "test" && input.NODE_ENV !== "production" &&
        url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    if (mode === "live" && input.NODE_ENV !== "production") return null;
    return { secretKey, webhookSecret, prices, origin: url.origin, livemode: mode === "live",
      checkoutEnabled: input.STRIPE_BILLING_ENABLED === "true" };
  } catch { return null; }
}

export type BillingConfig = NonNullable<ReturnType<typeof resolveBillingConfig>>;
export function getBillingConfig() { return resolveBillingConfig(process.env); }

export class BillingError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}

export function requireBillingConfig() {
  const config = getBillingConfig();
  if (!config) throw new BillingError("Billing is temporarily unavailable.");
  return config;
}
