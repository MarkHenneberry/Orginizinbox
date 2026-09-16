export const creditPacks = {
  small: { credits: 10_000, amountCents: 1_000, env: "STRIPE_PRICE_10000_CREDITS" },
  medium: { credits: 50_000, amountCents: 1_500, env: "STRIPE_PRICE_50000_CREDITS" },
  large: { credits: 100_000, amountCents: 2_000, env: "STRIPE_PRICE_100000_CREDITS" }
} as const;
export type CreditPack = keyof typeof creditPacks;
export function isCreditPack(value: unknown): value is CreditPack {
  return typeof value === "string" && Object.hasOwn(creditPacks, value);
}
