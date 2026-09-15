import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/marketing/Footer";
import { Header } from "@/components/marketing/Header";
import { ContextBackAction } from "@/components/product/ContextBackAction";
import { runtimeConfig } from "@/lib/config";

export const metadata: Metadata = {
  title: "Connect your inbox",
  robots: {
    index: false,
    follow: false
  }
};

export const dynamic = "force-dynamic";

export default function ProviderChooserPage() {
  const microsoftDevelopmentEnabled = runtimeConfig.microsoftAvailable;

  return (
    <>
      <Header />
      <main className="section">
        <div className="container max-w-5xl">
          <ContextBackAction className="mb-7" href="/" label="Back to homepage" />
          <div className="mx-auto max-w-2xl text-center">
            <p className="eyebrow">Connect an inbox</p>
            <h1 className="section-title mt-3">Connect your inbox</h1>
            <p className="muted mx-auto mt-4 max-w-xl text-lg leading-8">
              Choose an available inbox for a read-only Inbox Report. Cleanup is not available in production.
            </p>
          </div>
          <div className="mx-auto mt-8 grid max-w-4xl gap-5 md:grid-cols-2">
            <section className="panel flex min-h-64 flex-col p-6 md:p-7">
              <p className="eyebrow">Google</p>
              <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Gmail</h2>
              <p className="muted mt-3 leading-7">Connect your Gmail inbox.</p>
              <div className="mt-auto pt-7">
                {runtimeConfig.gmailAvailable ? <Link className="btn btn-primary focus-ring w-full justify-center" href="/connect/google">
                  Continue with Google
                </Link> : <p role="status">Gmail is temporarily unavailable.</p>}
              </div>
            </section>
            <section className="panel flex min-h-64 flex-col p-6 md:p-7">
              <p className="eyebrow">Microsoft</p>
              <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Outlook</h2>
              <p className="muted mt-3 leading-7">Outlook.com, Hotmail, and Microsoft 365.</p>
              <p className="muted mt-3 text-sm">
                {microsoftDevelopmentEnabled
                  ? "Read-only scanning is available. Cleanup is not enabled in production."
                  : "Outlook scanning and cleanup are not enabled yet."}
              </p>
              <div className="mt-auto pt-7">
                {microsoftDevelopmentEnabled ? (
                  <Link className="btn btn-secondary focus-ring w-full justify-center" href="/connect/microsoft">
                    Continue with Microsoft
                  </Link>
                ) : (
                  <span className="btn btn-secondary w-full cursor-not-allowed justify-center opacity-65" aria-disabled="true">
                    Coming soon
                  </span>
                )}
              </div>
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
