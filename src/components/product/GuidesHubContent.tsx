import Link from "next/link";
import { getMarketingPage } from "@/lib/marketing-pages";
import type { PublicPrimaryCta } from "@/lib/server/app-state";

const guideGroups = [
  {
    title: "Cleanup",
    slugs: ["bulk-delete-emails", "delete-emails-by-sender", "delete-old-emails", "delete-newsletters"]
  },
  {
    title: "Storage",
    slugs: ["free-up-gmail-storage", "free-up-outlook-storage"]
  },
  {
    title: "Workflow",
    slugs: ["inbox-reset"]
  },
  {
    title: "Providers",
    slugs: ["gmail-cleaner", "outlook-cleaner"]
  }
];

export function GuidesHubContent({ primaryCta }: { primaryCta: PublicPrimaryCta }) {
  return (
    <main>
      <section className="section">
        <div className="container">
          <p className="eyebrow">Guides</p>
          <h1 className="section-title mt-3">Inbox cleanup guides.</h1>
          <p className="muted mt-5 max-w-3xl text-lg leading-8">
            Find practical help for old email, recurring senders, newsletters, storage problems, Gmail, and Outlook.
          </p>
          <Link className="btn btn-primary focus-ring mt-8" href={primaryCta.href}>
            {primaryCta.label}
          </Link>
        </div>
      </section>
      <section className="section bg-white">
        <div className="container grid gap-8 md:grid-cols-2">
          {guideGroups.map((group) => (
            <section key={group.title}>
              <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">{group.title}</h2>
              <div className="mt-4 grid gap-4">
                {group.slugs.map((slug) => {
                  const page = getMarketingPage(slug);
                  if (!page) return null;
                  return (
                    <Link className="panel focus-ring block p-5 hover:border-[var(--teal)]" href={`/${page.slug}`} key={page.slug}>
                      <span className="text-lg font-extrabold text-[var(--navy)]">{page.title}</span>
                      <span className="muted mt-2 block text-sm leading-6">{page.description}</span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}
