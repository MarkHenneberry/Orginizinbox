import "server-only";
import Stripe from "stripe";
import { requireBillingConfig, stripeApiVersion } from "@/lib/billing/config";

export function createStripeClient() {
  return new Stripe(requireBillingConfig().secretKey, { apiVersion: stripeApiVersion, timeout: 8_000, maxNetworkRetries: 1 });
}
