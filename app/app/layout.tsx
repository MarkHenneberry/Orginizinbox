import type { Metadata } from "next";
import { AppHeader } from "@/components/product/AppHeader";
import { AppFooter } from "@/components/product/AppFooter";
import { runtimeConfig, siteConfig } from "@/lib/config";
import { getOptionalActiveReportState } from "@/lib/server/report-state";
import { getCreditPresentation } from "@/lib/server/credit-presentation";
import { getProductionCleanupUiState } from "@/lib/server/production-cleanup-ui";
import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";

export const metadata: Metadata = {
  title: "Inbox Report",
  robots: {
    index: false,
    follow: false
  }
};

export default async function ProductLayout({ children }: { children: React.ReactNode }) {
  const connection = await getCurrentProviderConnection();
  const report = await getOptionalActiveReportState();
  const credits = await getCreditPresentation();
  const production = process.env.NODE_ENV === "production";
  const cleanup = production ? await getProductionCleanupUiState() : null;
  const connected = connection.mode === "connected";
  const developmentCleanup = connected && (connection.provider === "gmail"
    ? runtimeConfig.gmailCleanupEnabled || runtimeConfig.gmailScalableCleanupDevEnabled
    : runtimeConfig.outlookCleanupDevEnabled && runtimeConfig.microsoftOAuthDevEnabled);

  return (
    <div className="product-shell">
      <AppHeader logoPath={siteConfig.logoPath} provider={connected ? connection.provider : undefined} availableCredits={credits?.available ?? null}
        reportAvailable={Boolean(report)} scanAvailable={connected}
        cleanupStartAvailable={production ? cleanup?.access === "available" : developmentCleanup}
        cleanupAvailable={production ? Boolean(cleanup?.hasJob || (report && cleanup?.access === "available")) : Boolean(report && developmentCleanup)} />
      <div className="product-content">{children}</div>
      <AppFooter />
    </div>
  );
}
