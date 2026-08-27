import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/marketing/Footer";
import { Header } from "@/components/marketing/Header";
import { runtimeConfig } from "@/lib/config";

export default function MicrosoftConnectPage() {
  const showDevOAuth = process.env.NODE_ENV !== "production" && runtimeConfig.microsoftOAuthDevEnabled;

  return (
    <>
      <Header />
      <main className="section">
        <div className="container max-w-3xl">
          <p className="eyebrow">Outlook</p>
          <h1 className="section-title mt-3">Outlook support is coming soon.</h1>
          <p className="muted mt-5 text-lg leading-8">We&apos;re finishing the Outlook version of Organizinbox.</p>
          <div className="panel mt-8 p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Useful next steps</h2>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link className="btn btn-primary focus-ring" href="/outlook-cleaner">
                Read about Outlook cleanup
              </Link>
              <Link className="btn btn-secondary focus-ring" href="/gmail-cleaner">
                Clean Gmail instead
              </Link>
            </div>
          </div>
          {showDevOAuth ? (
            <div className="panel mt-6 p-6">
              <p className="eyebrow">Development only</p>
              <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Microsoft OAuth test</h2>
              <p className="muted">This is hidden from normal product behavior and requires MICROSOFT_OAUTH_DEV_ENABLED=true.</p>
              <Link className="btn btn-secondary focus-ring mt-4" href="/api/oauth/microsoft/start">
                Start Microsoft dev OAuth
              </Link>
            </div>
          ) : null}
        </div>
      </main>
      <Footer />
    </>
  );
}

export const metadata: Metadata = {
  title: "Connect Microsoft",
  robots: {
    index: false,
    follow: false
  }
};
