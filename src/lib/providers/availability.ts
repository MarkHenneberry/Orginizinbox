import "server-only";
import { runtimeConfig } from "@/lib/config";

export type ProviderId = "gmail" | "microsoft";
export type ProviderAvailabilityStatus = "available" | "comingSoon";

export const providerAvailability: Record<ProviderId, { label: string; status: ProviderAvailabilityStatus }> = {
  gmail: {
    label: "Gmail",
    status: runtimeConfig.gmailAvailable ? "available" : "comingSoon"
  },
  microsoft: {
    label: "Outlook",
    status: runtimeConfig.microsoftAvailable ? "available" : "comingSoon"
  }
};

export function isProviderAvailable(provider: ProviderId) {
  return providerAvailability[provider].status === "available";
}
