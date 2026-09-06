import type { Metadata } from "next";
import Link from "next/link";
import { DisconnectMicrosoftConfirmation } from "@/components/product/DisconnectMicrosoftConfirmation";
import { ProviderConnectShell } from "@/components/product/ProviderConnectShell";
import { runtimeConfig } from "@/lib/config";
import { isOutlookCleanupDevelopmentEnabled } from "@/lib/domain/outlook-cleanup";
import { isMicrosoftOAuthDevelopmentUiEnabled } from "@/lib/providers/microsoft/development-access";
import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";

const errorCopy = {
  oauth_denied: "Microsoft connection was cancelled.",
  missing_code: "Microsoft did not return the authorization needed to connect.",
  state_invalid: "This Microsoft connection attempt expired or could not be verified.",
  token_exchange_failed: "Microsoft could not finish this connection.",
  scope_missing: "Microsoft mail permission was not granted.",
  refresh_token_missing: "Microsoft did not provide the persistent access needed for this connection.",
  identity_failed: "The Microsoft account identity could not be verified.",
  connection_save_failed: "Organizinbox could not save the Microsoft connection.",
  session_failed: "The Microsoft connection was saved, but the Organizinbox session could not be started."
} as const;

export default async function MicrosoftConnectPage({
  searchParams
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const showDevOAuth = isMicrosoftOAuthDevelopmentUiEnabled(
    process.env.NODE_ENV,
    runtimeConfig.microsoftOAuthDevEnabled
  );
  const connection = await getCurrentProviderConnection();
  const outlookCleanupEnabled = isOutlookCleanupDevelopmentEnabled({
    microsoftOAuthEnabled: runtimeConfig.microsoftOAuthDevEnabled,
    outlookCleanupEnabled: runtimeConfig.outlookCleanupDevEnabled,
    fixtureMode: runtimeConfig.fixtureMode,
    nodeEnv: process.env.NODE_ENV
  });
  const { reason } = await searchParams;
  const error = reason && reason in errorCopy ? errorCopy[reason as keyof typeof errorCopy] : undefined;

  return (
    <ProviderConnectShell
      description={showDevOAuth
        ? outlookCleanupEnabled
          ? "Microsoft connection, read-only Outlook scanning, and cleanup of up to 500 reviewed messages are available for development testing."
          : "Microsoft connection and read-only Outlook scanning are available for development testing. Outlook cleanup is not enabled yet."
        : "Outlook support is coming soon. Scanning and cleanup are not available yet."}
      eyebrow="Microsoft / Outlook"
      title="Connect Outlook"
    >
      {showDevOAuth ? (
        connection.mode === "connected" && connection.provider === "microsoft" ? (
          <>
            <p className="eyebrow">Microsoft connected</p>
            <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Your Outlook account is connected successfully</h2>
            <p className="muted mt-3">{outlookCleanupEnabled
              ? "You can scan this Outlook inbox read-only, then review cleanup for up to 500 Suggested messages."
              : "You can scan this Outlook inbox read-only. Cleanup is not enabled yet."}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link className="btn btn-primary focus-ring" href="/app/scan">Scan Outlook inbox</Link>
              <Link className="btn btn-secondary focus-ring" href="/app/account">Account</Link>
              <DisconnectMicrosoftConfirmation />
            </div>
          </>
        ) : (
          <>
            <p className="eyebrow">Development connection</p>
            <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Continue securely with Microsoft</h2>
            <p className="muted mt-3">This connects your account only. It does not read messages or change your mailbox.</p>
            {error ? (
              <p className="mt-5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-[var(--navy)]">
                {error} Try connecting again.
              </p>
            ) : null}
            <form action="/api/oauth/microsoft/start" className="mt-6" method="get">
              <button className="btn btn-primary focus-ring" type="submit">
                {error ? "Try connecting Microsoft again" : "Connect Outlook"}
              </button>
            </form>
          </>
        )
      ) : (
        <>
          <p className="eyebrow">Coming soon</p>
          <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Outlook connection is not available yet</h2>
          <p className="muted mt-3">Learn how Outlook cleanup will work, or use Organizinbox with Gmail today.</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link className="btn btn-primary focus-ring" href="/outlook-cleaner">Outlook cleanup</Link>
            <Link className="btn btn-secondary focus-ring" href="/gmail-cleaner">Clean Gmail instead</Link>
          </div>
        </>
      )}
    </ProviderConnectShell>
  );
}

export const metadata: Metadata = {
  title: "Connect Microsoft",
  robots: {
    index: false,
    follow: false
  }
};
