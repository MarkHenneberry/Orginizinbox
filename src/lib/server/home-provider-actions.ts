import "server-only";
import { runtimeConfig } from "@/lib/config";
import { getAppHomeState } from "./app-state";
import { getLinkedInboxes } from "./linked-inboxes";
import { assertProductionCleanupInfrastructure } from "./production-cleanup";
import { getBillingConfig } from "@/lib/billing/config";

export type HomeProviderAction = { provider: "gmail" | "microsoft"; label: string; href: string; connectionId?: string; available: boolean };
export function homepageAvailability() {
  const cleanup = (provider: "gmail" | "microsoft") => {
    if (!(provider === "gmail" ? runtimeConfig.gmailAvailable : runtimeConfig.microsoftAvailable)) return false;
    if (process.env.NODE_ENV !== "production") return provider === "gmail"
      ? runtimeConfig.gmailCleanupEnabled || runtimeConfig.gmailScalableCleanupDevEnabled
      : runtimeConfig.outlookCleanupDevEnabled && runtimeConfig.microsoftOAuthDevEnabled;
    try { assertProductionCleanupInfrastructure(provider, "forward"); return Boolean(getBillingConfig()); }
    catch { return false; }
  };
  const gmailCleanup = cleanup("gmail");
  const outlookCleanup = cleanup("microsoft");
  const names = [gmailCleanup ? "Gmail" : undefined, outlookCleanup ? "Outlook" : undefined].filter(Boolean);
  return { gmailCleanup, outlookCleanup, anyCleanup: names.length > 0,
    cleanupCopy: names.length ? `Cleanup is available for ${names.join(" and ")} with cleanup credits.` : "Cleanup is currently unavailable. Scanning does not move or delete anything." };
}

export async function getHomeProviderActions(): Promise<HomeProviderAction[]> {
  const [state, inboxes] = await Promise.all([getAppHomeState(), getLinkedInboxes()]);
  return (["gmail", "microsoft"] as const).map(provider => {
    const name = provider === "gmail" ? "Gmail" : "Outlook";
    const href = provider === "gmail" ? "/connect/google" : "/connect/microsoft";
    const available = provider === "gmail" ? runtimeConfig.gmailAvailable : runtimeConfig.microsoftAvailable;
    if (!available) return { provider, href, available, label: `${name} currently unavailable` };
    const active = "provider" in state && state.provider === provider;
    if (active && state.mode === "connected_active_report") return { provider, available, href: "/app/report", label: `View ${name} report` };
    if (active && state.mode === "connected_no_report") return { provider, available, href: "/app/scan", label: `Scan ${name} inbox` };
    const saved = inboxes.find(inbox => inbox.provider === provider && inbox.state === "ready");
    return saved ? { provider, available, href, label: `Open ${name} inbox`, connectionId: saved.id }
      : { provider, available, href, label: `Scan ${name} inbox` };
  });
}
