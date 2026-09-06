import Link from "next/link";
import { ContextBackAction } from "@/components/product/ContextBackAction";
import { GmailScanClient, OutlookScanClient } from "@/components/product/GmailScanClient";
import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";
import { getLiveScan, serializeScanProgress } from "@/lib/server/live-scan-store";
import { runtimeConfig } from "@/lib/config";
import { hasRequiredMicrosoftImapScope } from "@/lib/providers/microsoft/scopes";

export default async function ScanPage() {
  const connection = await getCurrentProviderConnection();
  const liveScan = connection.mode === "connected"
    ? await getLiveScan(connection.userId, connection.provider)
    : undefined;

  return (
    <main className="py-8">
      <div className="container max-w-4xl">
        <ContextBackAction className="mb-5" href="/app" label="Back to Organizinbox" />
        <p className="eyebrow">Scan</p>
        <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">Scan your inbox</h1>
        <p className="muted mt-3 max-w-2xl">We&apos;ll look at basic email details to find recurring senders, old mail, and likely clutter.</p>

        {connection.mode === "fixture" ? (
          <section className="panel mt-6 p-6">
            <p className="eyebrow">DEVELOPMENT FIXTURE</p>
            <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Fixture report is available</h2>
            <p className="muted">Fixture mode does not scan a real inbox.</p>
            <Link className="btn btn-primary focus-ring mt-4" href="/app/report">
              Open fixture report
            </Link>
          </section>
        ) : null}

        {connection.mode === "none" ? (
          <section className="panel mt-6 p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Connect Gmail first</h2>
            <p className="muted">A Gmail connection is required before scanning.</p>
            <Link className="btn btn-primary focus-ring mt-4" href="/connect/google">
              Connect Gmail
            </Link>
          </section>
        ) : null}

        {connection.mode === "needs_reconnect" && connection.provider === "gmail" ? (
          <section className="panel mt-6 p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Gmail connection needs attention</h2>
            <p className="muted">Reconnect Gmail, then approve access when Google asks.</p>
            <form action="/api/oauth/google/start" method="get">
              <button className="btn btn-primary focus-ring mt-4" type="submit">
                Reconnect Gmail
              </button>
            </form>
          </section>
        ) : null}

        {connection.mode === "needs_reconnect" && connection.provider === "microsoft" ? (
          <section className="panel mt-6 p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Microsoft connection needs attention</h2>
            <p className="muted">Reconnect Microsoft from the development connection page.</p>
            <Link className="btn btn-primary focus-ring mt-4" href="/connect/microsoft">
              Reconnect Microsoft
            </Link>
          </section>
        ) : null}

        {connection.mode === "connected" && connection.provider === "microsoft" ? (
          <>
            <p className="muted mt-3">{connection.accountEmail ? `${connection.accountEmail} is connected.` : "Microsoft is connected."}</p>
            <OutlookScanClient
              imapAvailable={runtimeConfig.outlookImapBenchmarkDevEnabled && hasRequiredMicrosoftImapScope(connection.imapScope)}
              imapBenchmarkEnabled={runtimeConfig.outlookImapBenchmarkDevEnabled}
              initialProgress={liveScan?.progress.provider === "microsoft" ? serializeScanProgress(liveScan.progress) : null}
            />
          </>
        ) : null}

        {connection.mode === "connected" && connection.provider === "gmail" ? (
          <>
            <p className="muted mt-3">{connection.accountEmail ? `${connection.accountEmail} is connected.` : "Gmail is connected."}</p>
            <GmailScanClient initialProgress={liveScan ? serializeScanProgress(liveScan.progress) : null} />
          </>
        ) : null}
      </div>
    </main>
  );
}
