import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/marketing/Footer";
import { Header } from "@/components/marketing/Header";
import { ContextBackAction } from "@/components/product/ContextBackAction";
import { getAppHomeState } from "@/lib/server/app-state";

export const metadata: Metadata = {
  title: "Connect Gmail",
  robots: {
    index: false,
    follow: false
  }
};

export default async function GoogleConnectPage() {
  const state = await getAppHomeState();
  const connectedHref = state.mode === "connected_active_report" ? "/app/report" : "/app/scan";
  const connectedLabel = state.mode === "connected_active_report" ? "Return to Inbox Report" : "Scan my inbox";

  return (
    <>
      <Header />
      <main className="section">
        <div className="container max-w-3xl">
          <ContextBackAction className="mb-6" href="/" label="Back to homepage" />
          <p className="eyebrow">Gmail</p>
          <h1 className="section-title mt-3">Connect Gmail</h1>
          <p className="muted mt-5 text-lg leading-8">
            Organizinbox needs access to scan your inbox and move messages you approve to Trash.
          </p>
          <ul className="mt-6 grid gap-3 pl-5 text-[var(--navy)]">
            <li>We don&apos;t read email bodies.</li>
            <li>We don&apos;t download attachments.</li>
            <li>We don&apos;t send email.</li>
            <li>We don&apos;t permanently delete email.</li>
            <li>We don&apos;t store your inbox.</li>
          </ul>
          <Link className="focus-ring mt-5 inline-flex rounded-md py-2 font-bold text-[var(--teal-dark)] hover:underline" href="/data-access">
            Read how data access works
          </Link>
          {state.mode === "connected_active_report" || state.mode === "connected_no_report" ? (
            <div className="panel mt-8 p-6">
              <p className="eyebrow">Gmail connected</p>
              <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">You do not need to reconnect Gmail</h2>
              <p className="muted">Continue with your current Inbox Report or start a new scan.</p>
              <Link className="btn btn-primary focus-ring mt-5" href={connectedHref}>
                {connectedLabel}
              </Link>
            </div>
          ) : (
            <div className="panel mt-8 p-6">
              <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">{state.mode === "needs_reconnect" ? "Reconnect Gmail" : "Ready to connect?"}</h2>
              <p className="muted">Google will ask you to approve Gmail access.</p>
              <div className="mt-5 flex flex-wrap gap-3">
                <form action="/api/oauth/google/start" method="get">
                  <button className="btn btn-primary focus-ring" type="submit">
                    {state.mode === "needs_reconnect" ? "Reconnect Gmail" : "Connect Gmail"}
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
