import Link from "next/link";
import { CleanupGuideContent } from "@/components/product/CleanupGuideContent";
import { RetentionDisclosure } from "@/components/product/RetentionDisclosure";
import { cleanupGuides } from "@/lib/cleanup-guides";
import { getBillingConfig } from "@/lib/billing/config";
import { creditPacks } from "@/lib/billing/packs";
import { runtimeConfig } from "@/lib/config";
import { providerAvailability } from "@/lib/providers/availability";
import { getMarketingPagesBySlugs } from "@/lib/marketing-pages";
import type { MarketingPage } from "@/lib/marketing-pages";
import type { PublicPrimaryCta } from "@/lib/server/app-state";

export function MarketingInfoContent({ page, appContext = false, primaryCta }: { page: MarketingPage; appContext?: boolean; primaryCta?: PublicPrimaryCta }) {
  const cta = appContext ? { href: "/app/data-access", label: "Data access" } : (primaryCta ?? { href: "/connect", label: page.cta });
  const relatedPages = getMarketingPagesBySlugs(page.relatedSlugs);
  const creditSalesAvailable = page.slug === "pricing" && getBillingConfig()?.checkoutEnabled;
  const outlookUnavailable = page.providerIntent === "outlook" && providerAvailability.microsoft.status === "comingSoon";
  const outlookDevelopmentConnection = page.providerIntent === "outlook" && runtimeConfig.microsoftOAuthDevEnabled;
  const providerUnavailable = page.providerIntent === "gmail" ? !runtimeConfig.gmailAvailable : outlookUnavailable;
  const hasGuide = Boolean(cleanupGuides[page.slug]);
  const preserveExplanation = hasGuide || page.contentCluster === "trust" || page.slug === "pricing";

  return (
    <main className="reading-content">
      <section className="section">
        <div className={page.slug === "pricing" ? "container max-w-3xl" : "container grid gap-10 md:grid-cols-[1.1fr_0.9fr] md:items-center"}>
          <div>
            <p className="eyebrow">{page.eyebrow}</p>
            <h1 className="section-title mt-3">{page.h1}</h1>
            <p className="muted mt-5 max-w-2xl text-lg leading-8">{!preserveExplanation && !runtimeConfig.development && page.providerIntent
              ? providerUnavailable ? "Connection and scanning for this provider are currently unavailable. Cleanup is not available." : "Read-only Inbox Reports are available for this provider. Cleanup is not available."
              : page.body}</p>
            {hasGuide ? <p className="mt-4 text-sm font-bold">{page.providerIntent === "gmail" || page.providerIntent === "outlook"
              ? providerUnavailable ? "Connection and scanning are currently unavailable for this provider. " : "Read-only Inbox Reports are available for enabled accounts. "
              : "These steps describe Organizinbox. Check connection and scan availability before you begin. "}Production cleanup is not available yet.</p> : null}
            {page.slug === "security" ? <RetentionDisclosure /> : null}
            {outlookUnavailable ? (
              <div className="mt-6 rounded-md border border-[var(--line)] bg-white p-5">
                <p className="m-0 text-sm font-extrabold text-[var(--navy)]">
                  {outlookDevelopmentConnection ? "Microsoft connection is available for development testing." : "Outlook support is coming soon."}
                </p>
                <p className="muted mb-0 mt-2 text-sm">
                  {outlookDevelopmentConnection
                    ? "Read-only Outlook scanning is available for development testing. Cleanup is not enabled yet."
                    : "We're finishing the Outlook version of Organizinbox."}
                </p>
              </div>
            ) : null}
            <div className="mt-8 flex flex-wrap gap-3">
              {creditSalesAvailable ? <Link href="/app/account" className="btn btn-secondary focus-ring">Buy cleanup credits</Link> : null}
              <Link href={cta.href} className="btn btn-primary focus-ring">
                {cta.label}
              </Link>
              {outlookUnavailable && runtimeConfig.gmailAvailable ? (
                <Link href="/gmail-cleaner" className="btn btn-secondary focus-ring">
                  {runtimeConfig.development ? "Clean Gmail instead" : "Gmail availability"}
                </Link>
              ) : !appContext ? (
                <Link href={appContext ? "/app/data-access" : "/data-access"} className="btn btn-secondary focus-ring">
                  Data access
                </Link>
              ) : null}
            </div>
            {page.slug === "pricing" ? <p className="muted mt-3 text-sm">Pay once. No subscription. No recurring charge. Credits don&apos;t expire.</p> : null}
          </div>
          {page.slug !== "pricing" ? <div className="panel p-6">
            <p className="m-0 text-sm font-extrabold text-[var(--navy)]">Product facts</p>
            <dl className="mt-5 grid gap-4 text-sm">
              <div className="flex justify-between gap-4 border-b border-[var(--line)] pb-3">
                <dt className="muted">Organizinbox permanently deletes email</dt>
                <dd className="m-0 font-bold">No</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-[var(--line)] pb-3">
                <dt className="muted">Email bodies fetched</dt>
                <dd className="m-0 font-bold">No</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-[var(--line)] pb-3">
                <dt className="muted">Attachments downloaded</dt>
                <dd className="m-0 font-bold">No</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="muted">Cleanup destination</dt>
                <dd className="m-0 font-bold">{runtimeConfig.development ? "Trash / Deleted Items" : "Cleanup unavailable"}</dd>
              </div>
            </dl>
          </div> : null}
        </div>
      </section>
      {page.slug === "pricing" ? <section className="section bg-white"><div className="container">
        <h2 className="text-3xl font-bold">Credit packs</h2>
        <div className="pack-terms"><span>No subscription</span><span>Credits don&apos;t expire</span><span>Same features in every pack</span></div>
        <div className="credit-packs">{Object.entries(creditPacks).map(([key, pack]) => <article key={key} className="credit-pack" data-recommended={pack.credits === 50000}>
          <p className="pack-label">{pack.credits === 50000 ? "Recommended" : "One-time purchase"}</p>
          <h3 className="text-xl font-bold">{pack.credits.toLocaleString("en-US")} credits</h3>
          <p className="pack-price">${pack.amountCents / 100} <small>USD, once</small></p>
          <p className="muted text-sm">Gmail and Outlook. Pay only for verified moves.</p>
        </article>)}</div>
        <p className="mt-5">Use credits across your linked Gmail and Outlook inboxes. One credit pays for one email verified as moved to Trash or Deleted Items. Verified Undo returns that credit.</p>
        <p className="muted">Scanning and reviewing are free. Protected, excluded, failed and uncertain moves cost no credits. Purchases add to your balance. Cleanup and Undo remain subject to provider availability and the displayed Undo deadline.</p>
        {!creditSalesAvailable ? <p className="font-bold">Credit purchases are not available yet.</p> : null}
      </div></section> : null}
      <section className="section bg-white">
        <div className="container">
          <h2 className="m-0 text-3xl font-extrabold text-[var(--navy)]">What you can do</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {(!runtimeConfig.development && page.contentCluster !== "trust" && page.slug !== "pricing" && page.providerIntent
              ? [providerUnavailable ? "Provider currently unavailable" : "Read-only Inbox Report", "Cleanup is not available", "No permanent deletion"]
              : page.bullets).map((bullet) => (
              <div className="panel p-5" key={bullet}>
                <p className="m-0 font-bold">{bullet}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      {hasGuide ? <CleanupGuideContent slug={page.slug} /> : null}
      {relatedPages.length ? (
        <section className="section">
          <div className="container">
            <h2 className="m-0 text-3xl font-extrabold text-[var(--navy)]">Related guides</h2>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {relatedPages.map((relatedPage) => (
                <Link className="panel focus-ring block p-5 hover:border-[var(--teal)]" href={`/${relatedPage.slug}`} key={relatedPage.slug}>
                  <span className="font-extrabold text-[var(--navy)]">{relatedPage.title}</span>
                  <span className="muted mt-2 block text-sm leading-6">{relatedPage.description}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      {!appContext ? (
        <section className="section bg-white">
          <div className="container">
            <div className="max-w-3xl">
              <p className="eyebrow">Next step</p>
              <h2 className="m-0 mt-2 text-3xl font-extrabold text-[var(--navy)]">See what&apos;s filling your inbox.</h2>
              <p className="muted mt-4 leading-8">
                Organizinbox shows the senders, categories, and old mail creating the clutter before you approve cleanup.
              </p>
              <Link className="btn btn-primary focus-ring mt-6" href={cta.href}>
                {cta.label}
              </Link>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
