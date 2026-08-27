export type ProviderId = "gmail" | "microsoft";
export type ProviderAvailabilityStatus = "available" | "comingSoon";

export const providerAvailability: Record<ProviderId, { label: string; status: ProviderAvailabilityStatus }> = {
  gmail: {
    label: "Gmail",
    status: "available"
  },
  microsoft: {
    label: "Outlook",
    status: "comingSoon"
  }
};

export function isProviderAvailable(provider: ProviderId) {
  return providerAvailability[provider].status === "available";
}
