import Link from "next/link";
import { BackToReportAction } from "@/components/product/AppContextActions";
import { DisconnectGmailConfirmation } from "@/components/product/DisconnectGmailConfirmation";
import { DisconnectMicrosoftConfirmation } from "@/components/product/DisconnectMicrosoftConfirmation";
import { RemoveGoogleAuthorizationConfirmation } from "@/components/product/RemoveGoogleAuthorizationConfirmation";
import { runtimeConfig } from "@/lib/config";
import { isOutlookCleanupDevelopmentEnabled } from "@/lib/domain/outlook-cleanup";
import { getAccountConnectionState } from "@/lib/server/account-state";
import { getOptionalActiveReportState } from "@/lib/server/report-state";

export default async function AccountPage() {
  const activeReport = await getOptionalActiveReportState();
  const account = await getAccountConnectionState(Boolean(activeReport));
  const outlookCleanupEnabled = isOutlookCleanupDevelopmentEnabled({
    microsoftOAuthEnabled: runtimeConfig.microsoftOAuthDevEnabled,
    outlookCleanupEnabled: runtimeConfig.outlookCleanupDevEnabled,
    fixtureMode: runtimeConfig.fixtureMode,
    nodeEnv: process.env.NODE_ENV
  });

  return (
    <main className="py-8">
      <div className="container max-w-4xl">
        <BackToReportAction activeReport={activeReport} />
        <p className="eyebrow">Account</p>
        <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">Account</h1>
        <section className="panel mt-6 p-6">
          {account.mode === "fixture" ? <FixtureAccount hasActiveReport={account.hasActiveReport} /> : null}
          {account.mode === "connected" ? <ConnectedAccount accountEmail={account.accountEmail} hasActiveReport={account.hasActiveReport} outlookCleanupEnabled={outlookCleanupEnabled} provider={account.provider} /> : null}
          {account.mode === "none" ? <NoProviderAccount /> : null}
        </section>
      </div>
    </main>
  );
}

function ConnectedAccount({
  accountEmail,
  hasActiveReport,
  outlookCleanupEnabled,
  provider
}: {
  accountEmail?: string;
  hasActiveReport: boolean;
  outlookCleanupEnabled: boolean;
  provider: "gmail" | "microsoft";
}) {
  const gmail = provider === "gmail";
  return (
    <>
      <p className="eyebrow">Connected inbox</p>
      <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">{gmail ? "Gmail connected" : "Microsoft connected"}</h2>
      <p className="muted">{gmail
        ? "Organizinbox can scan this inbox when you ask."
        : outlookCleanupEnabled
          ? "Organizinbox scans this Outlook inbox read-only. Development cleanup can move up to 500 reviewed messages to Deleted Items."
          : "Organizinbox can scan this Outlook inbox read-only. Outlook cleanup is not available yet."}</p>
      <dl className="mt-5 grid gap-3 text-sm">
        <div className="flex flex-wrap justify-between gap-4 border-b border-[var(--line)] pb-3">
          <dt className="muted">Connection status</dt>
          <dd className="m-0 font-bold">Connected</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-4 border-b border-[var(--line)] pb-3">
          <dt className="muted">Connected account</dt>
          <dd className="m-0 font-bold">{accountEmail ?? (gmail ? "Gmail account" : "Microsoft account")}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-4">
          <dt className="muted">Current report</dt>
          <dd className="m-0 font-bold">{hasActiveReport ? "Ready to view" : "No current report"}</dd>
        </div>
      </dl>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link className="btn btn-primary focus-ring" href={hasActiveReport ? "/app/report" : "/app/scan"}>
          {hasActiveReport ? "View Inbox Report" : gmail ? "Scan my inbox" : "Scan Outlook inbox"}
        </Link>
        {gmail ? <DisconnectGmailConfirmation /> : <DisconnectMicrosoftConfirmation />}
      </div>
      {gmail ? <div className="mt-8 border-t border-[var(--line)] pt-6">
        <p className="eyebrow">Google Account authorization</p>
        <h3 className="m-0 mt-2 text-lg font-extrabold text-[var(--navy)]">Remove access at Google too</h3>
        <p className="muted mt-2 text-sm">Also remove Organizinbox from the apps connected to your Google Account.</p>
        <p className="muted mt-2 text-sm">Google may take a short time to finish removing the authorization.</p>
        <div className="mt-3">
          <RemoveGoogleAuthorizationConfirmation />
        </div>
      </div> : null}
    </>
  );
}

function FixtureAccount({ hasActiveReport }: { hasActiveReport: boolean }) {
  return (
    <>
      <p className="eyebrow">DEVELOPMENT FIXTURE</p>
      <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Fixture session</h2>
      <p className="muted">Fixture mode is enabled. This is not a real connected Gmail or Outlook account.</p>
      <Link className="btn btn-primary focus-ring mt-3" href={hasActiveReport ? "/app/report" : "/connect"}>
        {hasActiveReport ? "View fixture report" : "Connect an inbox"}
      </Link>
    </>
  );
}

function NoProviderAccount() {
  return (
    <>
      <p className="eyebrow">Connection</p>
      <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">No provider connected</h2>
      <p className="muted">Choose the inbox you want to connect.</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link className="btn btn-primary focus-ring" href="/connect">Connect an inbox</Link>
        <Link className="btn btn-secondary focus-ring" href="/outlook-cleaner">
          Outlook support
        </Link>
      </div>
      <div className="mt-8 border-t border-[var(--line)] pt-6">
        <p className="muted m-0 text-sm">Want to remove Organizinbox from your Google Account too?</p>
        <a
          className="focus-ring mt-2 inline-flex rounded-md py-2 text-sm font-bold text-[var(--teal-dark)] hover:underline"
          href="https://myaccount.google.com/connections"
          rel="noreferrer"
          target="_blank"
        >
          Manage connected apps in your Google Account (opens in a new tab)
        </a>
      </div>
    </>
  );
}
