import Link from "next/link";
import { ContextBackAction } from "@/components/product/ContextBackAction";
import { GmailBenchmarkClient } from "@/components/product/GmailBenchmarkClient";
import { runtimeConfig } from "@/lib/config";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { getLiveScan, serializeBenchmark } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export default async function GmailBenchmarkPage() {
  if (process.env.NODE_ENV === "production" || !runtimeConfig.gmailBenchmarkEnabled) {
    return (
      <main className="py-8">
        <div className="container max-w-3xl">
          <p className="eyebrow">Development only</p>
          <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">Gmail benchmark is disabled</h1>
          <p className="muted mt-3">Set GMAIL_BENCHMARK_ENABLED=true in local development to use this page.</p>
          <ContextBackAction className="mt-5" href="/app" label="Back to Organizinbox" />
        </div>
      </main>
    );
  }

  const session = await getSession();
  let connectionError: string | undefined;
  const activeConnection = session?.userId
    ? await getActiveGmailConnection(session.userId, session.providerConnectionId).catch((error: unknown) => {
        connectionError = error instanceof Error ? error.message : "Gmail connection is not ready.";
        return null;
      })
    : null;
  const liveScan = session?.userId ? getLiveScan(session.userId) : undefined;

  return (
    <main className="py-8">
      <div className="container">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Development benchmark</p>
            <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">Gmail IMAP metadata scan</h1>
            <p className="muted mt-2 max-w-3xl">
              Measures OAuth-backed Gmail IMAP over TLS with read-only All Mail metadata fetches. Subject is processed transiently for protection only; body content and attachments are not fetched.
            </p>
          </div>
          <Link className="btn btn-secondary focus-ring" href="/app/report">
            Open report
          </Link>
        </div>

        {connectionError ? (
          <section className="panel max-w-2xl p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Gmail connection needs attention</h2>
            <p className="muted mt-3">{connectionError}</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <form action="/api/oauth/google/start" method="get">
                <button className="btn btn-primary focus-ring" type="submit">
                  Reconnect Gmail
                </button>
              </form>
            </div>
          </section>
        ) : activeConnection ? (
          <GmailBenchmarkClient initialProgress={liveScan ? serializeBenchmark(liveScan.progress) : null} />
        ) : (
          <section className="panel max-w-2xl p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Connect Gmail</h2>
            <p className="muted mt-3">
              A Gmail connection is required before the benchmark can scan live metadata.
            </p>
            <form action="/api/oauth/google/start" method="get">
              <button className="btn btn-primary focus-ring mt-5" type="submit">
                Connect Gmail
              </button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
