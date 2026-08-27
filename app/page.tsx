import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/marketing/Footer";
import { Header } from "@/components/marketing/Header";
import { StructuredData } from "@/components/marketing/StructuredData";
import { ReportPreview } from "@/components/product/ReportPreview";
import { pricingConfig } from "@/lib/config";
import { getFixtureInboxReport } from "@/lib/fixtures/inbox";
import { getPublicPrimaryCta } from "@/lib/server/app-state";

const popularGuides = [
  { href: "/delete-old-emails", label: "Delete old emails" },
  { href: "/delete-emails-by-sender", label: "Delete emails by sender" },
  { href: "/delete-newsletters", label: "Delete newsletters" },
  { href: "/bulk-delete-emails", label: "Bulk delete emails" },
  { href: "/free-up-gmail-storage", label: "Free up Gmail storage" },
  { href: "/inbox-reset", label: "Inbox reset" }
];

const productPaths = [
  { href: "/gmail-cleaner", label: "Gmail Cleaner", body: "Find recurring senders, old mail, and Gmail clutter." },
  { href: "/outlook-cleaner", label: "Outlook Cleaner", body: "See how Outlook cleanup will work. Support is coming soon." },
  { href: "/guides", label: "Guides", body: "Get practical help for common inbox cleanup problems." },
  { href: "/pricing", label: "Pricing", body: "Start with a free Inbox Scan." },
  { href: "/security", label: "Security", body: "See how Organizinbox protects access and cleanup actions." }
];

export const metadata: Metadata = {
  title: "See what's clogging your inbox",
  description: "Clean thousands of unwanted Gmail and Outlook emails safely after reviewing a transparent Inbox Report.",
  alternates: {
    canonical: "/"
  }
};

export default async function HomePage() {
  const report = getFixtureInboxReport();
  const primaryCta = await getPublicPrimaryCta();

  return (
    <>
      <StructuredData />
      <Header />
      <main>
        <section className="border-b border-[var(--line)] bg-[var(--soft)] py-16 md:py-20">
          <div className="container grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <p className="eyebrow">Gmail + Outlook cleanup</p>
              <h1 className="mt-3 text-5xl font-extrabold leading-none text-[var(--navy)] md:text-7xl">
                See what&apos;s clogging your inbox.
              </h1>
              <p className="mt-6 max-w-2xl text-xl font-bold text-[var(--navy)]">
                Organizinbox finds the senders and old email taking over your inbox, then helps you clean thousands of messages safely.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href={primaryCta.href} className="btn btn-primary focus-ring">
                  {primaryCta.label}
                </Link>
                <Link href="/outlook-cleaner" className="btn btn-secondary focus-ring">
                  Outlook support
                </Link>
              </div>
              <ul className="mt-8 grid gap-3 p-0 text-sm font-bold text-[var(--navy)] sm:grid-cols-2" aria-label="Trust statements">
                {["You review what gets cleaned", "Nothing is permanently deleted", "We don't sell your inbox data", "Disconnect when you're finished"].map((item) => (
                  <li className="list-none" key={item}>
                    <span className="mr-2 text-[var(--teal)]" aria-hidden="true">&#10003;</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <ReportPreview report={report} />
          </div>
        </section>

        <section id="product" className="section bg-white">
          <div className="container">
            <p className="eyebrow">Example Inbox Report</p>
            <h2 className="section-title mt-3">See where the clutter comes from.</h2>
            <div className="mt-8 grid gap-4 md:grid-cols-5">
              {[
                ["Emails analyzed", report.totals.messages.toLocaleString()],
                ["Emails you may want to clean", report.totals.cleanupCandidates.toLocaleString()],
                ["Unread older than one year", report.totals.unreadOlderThanOneYear.toLocaleString()],
                ["Recurring senders", report.totals.recurringSenders.toLocaleString()],
                ["Protected messages", report.totals.protectedMessages.toLocaleString()]
              ].map(([label, value]) => (
                <div className="panel p-5" key={label}>
                  <p className="muted m-0 text-sm">{label}</p>
                  <p className="m-0 mt-3 text-2xl font-extrabold text-[var(--navy)]">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="container">
            <p className="eyebrow">Start here</p>
            <h2 className="section-title mt-3">Choose the path that matches your inbox.</h2>
            <div className="mt-8 grid gap-4 md:grid-cols-5">
              {productPaths.map((path) => (
                <Link className="panel focus-ring block p-5 hover:border-[var(--teal)]" href={path.href} key={path.href}>
                  <span className="font-extrabold text-[var(--navy)]">{path.label}</span>
                  <span className="muted mt-2 block text-sm leading-6">{path.body}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="section">
          <div className="container">
            <p className="eyebrow">How it works</p>
            <h2 className="section-title mt-3">Four simple steps.</h2>
            <div className="mt-8 grid gap-4 md:grid-cols-4">
              {["Connect", "Scan", "Review", "Clean"].map((step, index) => (
                <div className="panel p-5" key={step}>
                  <p className="badge">{index + 1}</p>
                  <h3 className="mt-5 text-xl font-extrabold text-[var(--navy)]">{step}</h3>
                  <p className="muted text-sm">
                    {[
                      "Connect Gmail securely.",
                      "See what's filling your inbox.",
                      "Check what Organizinbox recommends cleaning.",
                      "Move unwanted email to Trash in a few clicks."
                    ][index]}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section bg-white">
          <div className="container grid gap-8 md:grid-cols-2">
            <div>
              <p className="eyebrow">Important mail stays protected</p>
              <h2 className="section-title mt-3">When we&apos;re unsure, we leave it alone.</h2>
              <p className="muted mt-5 leading-8">
                Recent, starred, important, account, billing, and personal messages stay out of automatic cleanup recommendations.
              </p>
            </div>
            <div className="panel p-6">
              <h3 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Biggest inbox offenders</h3>
              <div className="mt-5 grid gap-3">
                {report.senders.slice(0, 5).map((sender) => (
                  <div className="grid grid-cols-[1fr_auto] gap-3 border-b border-[var(--line)] pb-3" key={sender.senderKey}>
                    <span className="font-bold">{sender.displayName}</span>
                    <span className="font-extrabold text-[var(--navy)]">{sender.totalMessages.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="container grid gap-6 md:grid-cols-3">
            <div>
              <p className="eyebrow">Privacy</p>
              <h2 className="mt-3 text-3xl font-extrabold text-[var(--navy)]">Plain-language data access.</h2>
              <p className="muted">We don&apos;t store your inbox. Basic email details are processed only while building your report and completing cleanup you approve.</p>
            </div>
            <div>
              <p className="eyebrow">Compatibility</p>
              <h2 className="mt-3 text-3xl font-extrabold text-[var(--navy)]">Gmail now. Outlook soon.</h2>
              <p className="muted">Gmail is available today. We&apos;re finishing the Outlook version of Organizinbox.</p>
            </div>
            <div>
              <p className="eyebrow">Pricing</p>
              <h2 className="mt-3 text-3xl font-extrabold text-[var(--navy)]">{pricingConfig.freeScan.label}.</h2>
              <p className="muted">See what&apos;s filling your inbox before deciding what to clean.</p>
            </div>
          </div>
        </section>

        <section className="section bg-white">
          <div className="container">
            <h2 className="section-title">FAQ</h2>
            <div className="mt-8 grid gap-4 md:grid-cols-2">
              {[
                ["Does Organizinbox permanently delete email?", "No. Unwanted email goes to Trash, where it can still be recovered."],
                ["Does Organizinbox read my emails?", "We don't read email bodies, download attachments, or send email."],
                ["Can I use it with Outlook?", "Outlook support is coming soon. The current production cleanup path is Gmail."],
                ["What if Organizinbox is unsure?", "We leave the message alone. You review every cleanup group before anything moves to Trash."]
              ].map(([question, answer]) => (
                <div className="panel p-5" key={question}>
                  <h3 className="m-0 text-lg font-extrabold text-[var(--navy)]">{question}</h3>
                  <p className="muted mb-0">{answer}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="container">
            <p className="eyebrow">Popular inbox cleanup guides</p>
            <h2 className="section-title mt-3">Useful next reading.</h2>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {popularGuides.map((guide) => (
                <Link className="panel focus-ring block p-5 font-extrabold text-[var(--navy)] hover:border-[var(--teal)]" href={guide.href} key={guide.href}>
                  {guide.label}
                </Link>
              ))}
            </div>
          </div>
        </section>
        <section className="section border-t border-[var(--line)] bg-white">
          <div className="container max-w-3xl text-center">
            <h2 className="section-title">See what&apos;s filling your inbox.</h2>
            <p className="muted mt-4 text-lg">Unwanted email goes to Trash. Nothing is permanently deleted.</p>
            <Link className="btn btn-primary focus-ring mt-6" href={primaryCta.href}>
              {primaryCta.label}
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
