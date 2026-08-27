import Link from "next/link";
import { getAppHomeState } from "@/lib/server/app-state";

export default async function AppIndexPage() {
  const state = await getAppHomeState();

  return (
    <main className="py-8">
      <div className="container max-w-5xl">
        <p className="eyebrow">Organizinbox</p>
        <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">See what&apos;s filling your inbox</h1>
        <p className="muted mt-3 max-w-3xl">Scan your inbox, review the recommendations, and move unwanted email to Trash.</p>

        {state.mode === "fixture" ? (
          <section className="panel mt-6 p-6">
            <p className="eyebrow">DEVELOPMENT FIXTURE</p>
            <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Fixture report available</h2>
            <p className="muted">Fixture mode is enabled. This is not a connected Gmail inbox.</p>
            <Link className="btn btn-primary focus-ring mt-4" href="/app/report">
              Open fixture report
            </Link>
          </section>
        ) : null}

        {state.mode === "none" ? (
          <section className="panel mt-6 p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">No provider connected</h2>
            <p className="muted">Connect Gmail to scan your inbox. Outlook support is coming soon.</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link className="btn btn-primary focus-ring" href="/connect/google">
                Connect Gmail
              </Link>
              <Link className="btn btn-secondary focus-ring" href="/outlook-cleaner">
                Outlook support
              </Link>
            </div>
          </section>
        ) : null}

        {state.mode === "needs_reconnect" ? (
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

        {state.mode === "connected_no_report" ? (
          <section className="panel mt-6 p-6">
            <p className="eyebrow">Gmail connected</p>
            <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">{state.reportExpired ? "Your Inbox Report has expired" : "Ready to scan your inbox"}</h2>
            <p className="muted">
              {state.accountEmail ? `${state.accountEmail} is still connected.` : "Your Gmail account is still connected."}{" "}
              {state.reportExpired ? "Scan again to create a fresh report." : "Start a scan to create your Inbox Report."}
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link className="btn btn-primary focus-ring" href="/app/scan">
                {state.reportExpired ? "Scan again" : "Scan my inbox"}
              </Link>
              <Link className="btn btn-secondary focus-ring" href="/app/account">
                Account
              </Link>
            </div>
          </section>
        ) : null}

        {state.mode === "connected_active_report" ? (
          <section className="panel mt-6 p-6">
            <p className="eyebrow">Gmail connected</p>
            <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">
              {state.reportStale ? "Your Inbox Report needs a refresh" : "Your Inbox Report is ready"}
            </h2>
            <p className="muted">{state.accountEmail ? `${state.accountEmail} is connected.` : "Your Gmail account is connected."}</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Metric label="Emails analyzed" value={state.summary.messages.toLocaleString()} />
              <Metric label="Emails you may want to clean" value={state.summary.cleanupCandidates.toLocaleString()} />
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link className="btn btn-primary focus-ring" href="/app/report">
                View Inbox Report
              </Link>
              <Link className="btn btn-secondary focus-ring" href="/app/scan">
                Rescan
              </Link>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--line)] p-4">
      <p className="muted m-0 text-sm">{label}</p>
      <p className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">{value}</p>
    </div>
  );
}
