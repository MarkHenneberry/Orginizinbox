import Link from "next/link";
import { redirect } from "next/navigation";
import { BillingActions } from "@/components/product/BillingActions";
import { ProviderUnavailable } from "@/components/product/ProviderUnavailable";
import { BackToReportAction } from "@/components/product/AppContextActions";
import { DisconnectGmailConfirmation } from "@/components/product/DisconnectGmailConfirmation";
import { DisconnectMicrosoftConfirmation } from "@/components/product/DisconnectMicrosoftConfirmation";
import { RemoveGoogleAuthorizationConfirmation } from "@/components/product/RemoveGoogleAuthorizationConfirmation";
import { runtimeConfig } from "@/lib/config";
import { getBillingConfig } from "@/lib/billing/config";
import { getAccountConnectionState } from "@/lib/server/account-state";
import { getOptionalActiveReportState } from "@/lib/server/report-state";
import { getCreditPresentation, getLinkedInboxCount } from "@/lib/server/credit-presentation";

export default async function AccountPage({ searchParams }: { searchParams?: Promise<{ billing?: string }> } = {}) {
  const query = await searchParams;
  // Keep existing Checkout return URLs working without changing Stripe configuration.
  if (query?.billing === "returned" || query?.billing === "cancelled") redirect(`/app/credits?billing=${query.billing}`);
  const activeReport = await getOptionalActiveReportState();
  const account = await getAccountConnectionState(Boolean(activeReport));
  const credits = await getCreditPresentation();
  const linked = await getLinkedInboxCount();
  const connected = account.mode === "connected";
  return <main className="settings-page"><div className="container settings-width">
    <BackToReportAction activeReport={activeReport} />
    <header className="settings-heading"><h1>Account</h1><p>Manage your inbox connection and account settings.</p></header>
    <section className="connection-section" aria-label="Inbox connection">
      {account.mode === "unavailable" ? <ProviderUnavailable provider={account.provider} /> : null}
      {connected ? <>
        <div className="settings-section-title"><h2>{account.provider === "gmail" ? "Gmail" : "Microsoft"}</h2><span className="badge">Connected</span></div>
        <p className="connected-address">{account.accountEmail ?? (account.provider === "gmail" ? "Gmail account" : "Microsoft account")}</p>
        <p className="muted text-sm">Organizinbox scans your inbox when you ask. Scanning does not move or delete anything.</p>
        <div className="connection-actions">
          <div><span className="muted text-sm">Current report</span><p className="m-0 font-bold">{account.hasActiveReport ? "Ready to view" : "No current report"}</p></div>
          <Link className="btn btn-primary focus-ring" href={account.hasActiveReport ? "/app/report" : "/app/scan"}>{account.hasActiveReport ? "View Inbox Report" : "Scan my inbox"}</Link>
          <div className="connection-disconnect">{account.provider === "gmail" ? <DisconnectGmailConfirmation /> : <DisconnectMicrosoftConfirmation />}</div>
        </div>
      </> : null}
      {account.mode === "fixture" ? <><p className="eyebrow">DEVELOPMENT FIXTURE</p><h2>Fixture session</h2><p className="muted">Fixture mode is enabled. This is not a real connected Gmail or Outlook account.</p><Link className="btn btn-secondary focus-ring" href="/app/report">View fixture report</Link></> : null}
      {account.mode === "none" ? <><h2>No provider connected</h2><p className="muted">Choose the inbox you want to connect.</p><Link className="btn btn-primary focus-ring" href="/connect">Connect an inbox</Link></> : null}
    </section>
    <div className="settings-columns">
      <section aria-labelledby="account-credits"><h2 id="account-credits">Credits</h2>
        {credits ? <><p className="settings-metric">{credits.available.toLocaleString("en-US")} <span>available</span></p><p className="muted text-sm">{credits.reserved.toLocaleString("en-US")} reserved for active cleanup</p></> : <p className="muted">Your balance is currently unavailable.</p>}
        <Link className="btn btn-secondary focus-ring" href="/app/credits">Manage credits</Link>
      </section>
      <section id="linked-inboxes" aria-labelledby="linked-title"><h2 id="linked-title">Linked inboxes</h2>
        <p className="muted">{linked === null ? "Connect an inbox to manage your shared balance." : `${linked} ${linked === 1 ? "inbox uses" : "inboxes share"} this credit balance.`}</p>
        <p className="muted text-sm">One inbox is active at a time. Reconnect a linked inbox to use its report.</p>
        {connected && getBillingConfig() ? <details className="link-inbox-disclosure"><summary className="text-link focus-ring">Link another inbox</summary>
          <BillingActions canBuy={false} canRefresh={false} gmail={runtimeConfig.gmailAvailable} microsoft={runtimeConfig.microsoftAvailable} />
        </details> : null}
      </section>
    </div>
    {connected && account.provider === "gmail" ? <section className="advanced-settings">
      <details><summary className="focus-ring">Google Account authorization</summary>
        <h3>Remove access at Google too</h3><p className="muted text-sm">Also remove Organizinbox from the apps connected to your Google Account. Google may take a short time to finish removing the authorization.</p>
        <RemoveGoogleAuthorizationConfirmation />
      </details>
    </section> : null}
    {account.mode === "none" ? <p className="muted text-sm">Previously connected Gmail? <a className="text-link" href="https://myaccount.google.com/connections" rel="noreferrer" target="_blank">Manage connected apps in your Google Account (opens in a new tab)</a>.</p> : null}
  </div></main>;
}
