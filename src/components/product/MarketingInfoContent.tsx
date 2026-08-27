import Link from "next/link";
import { providerAvailability } from "@/lib/providers/availability";
import { getMarketingPagesBySlugs } from "@/lib/marketing-pages";
import type { MarketingPage } from "@/lib/marketing-pages";
import type { PublicPrimaryCta } from "@/lib/server/app-state";

export function MarketingInfoContent({ page, appContext = false, primaryCta }: { page: MarketingPage; appContext?: boolean; primaryCta?: PublicPrimaryCta }) {
  const cta = appContext ? { href: "/app/data-access", label: "Data access" } : (primaryCta ?? { href: "/connect/google", label: page.cta });
  const relatedPages = getMarketingPagesBySlugs(page.relatedSlugs);
  const outlookUnavailable = page.providerIntent === "outlook" && providerAvailability.microsoft.status === "comingSoon";

  return (
    <main>
      <section className="section">
        <div className="container grid gap-10 md:grid-cols-[1.1fr_0.9fr] md:items-center">
          <div>
            <p className="eyebrow">{page.eyebrow}</p>
            <h1 className="section-title mt-3">{page.h1}</h1>
            <p className="muted mt-5 max-w-2xl text-lg leading-8">{page.body}</p>
            {outlookUnavailable ? (
              <div className="mt-6 rounded-md border border-[var(--line)] bg-white p-5">
                <p className="m-0 text-sm font-extrabold text-[var(--navy)]">Outlook support is coming soon.</p>
                <p className="muted mb-0 mt-2 text-sm">We&apos;re finishing the Outlook version of Organizinbox.</p>
              </div>
            ) : null}
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href={cta.href} className="btn btn-primary focus-ring">
                {cta.label}
              </Link>
              {outlookUnavailable ? (
                <Link href="/gmail-cleaner" className="btn btn-secondary focus-ring">
                  Clean Gmail instead
                </Link>
              ) : !appContext ? (
                <Link href={appContext ? "/app/data-access" : "/data-access"} className="btn btn-secondary focus-ring">
                  Data access
                </Link>
              ) : null}
            </div>
          </div>
          <div className="panel p-6">
            <p className="m-0 text-sm font-extrabold text-[var(--navy)]">Product facts</p>
            <dl className="mt-5 grid gap-4 text-sm">
              <div className="flex justify-between gap-4 border-b border-[var(--line)] pb-3">
                <dt className="muted">Permanent deletion</dt>
                <dd className="m-0 font-bold">No</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-[var(--line)] pb-3">
                <dt className="muted">Normal body retrieval</dt>
                <dd className="m-0 font-bold">No</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-[var(--line)] pb-3">
                <dt className="muted">Attachment retrieval</dt>
                <dd className="m-0 font-bold">No</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="muted">Cleanup destination</dt>
                <dd className="m-0 font-bold">Trash / Deleted Items</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>
      <section className="section bg-white">
        <div className="container">
          <h2 className="m-0 text-3xl font-extrabold text-[var(--navy)]">What you can do</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {page.bullets.map((bullet) => (
              <div className="panel p-5" key={bullet}>
                <p className="m-0 font-bold">{bullet}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
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
