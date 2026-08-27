import Link from "next/link";

type PublicCta = {
  href: string;
  label: string;
};

export function PrivacyContent({ appContext = false, primaryCta }: { appContext?: boolean; primaryCta?: PublicCta }) {
  const cta = primaryCta ?? { href: "/connect/google", label: "Clean my inbox" };

  return (
    <main>
      <section className="section">
        <div className="container">
          <p className="eyebrow">Privacy</p>
          <h1 className="section-title mt-3">Privacy is part of the product.</h1>
          <p className="muted mt-5 max-w-3xl text-lg leading-8">
            Organizinbox is built around temporary inbox processing. It does not sell inbox-derived data, build advertising profiles, train AI models on mailbox data, or store a permanent copy of your inbox.
          </p>
          <p className="muted mt-4 max-w-3xl text-lg leading-8">
            Normal scans do not retrieve email bodies or attachments. Subject lines are processed temporarily only to protect messages that may be important, then discarded without being stored, logged, sent to analytics, or sent to AI systems.
          </p>
        </div>
      </section>
      <section className="section bg-white">
        <div className="container grid gap-4 md:grid-cols-3">
          {[
            ["No inbox sale", "Mailbox-derived data is never sold or used for advertising."],
            ["No AI training", "Scan and cleanup flows do not send mailbox data to AI training systems."],
            ["Disconnect clears saved access", "Disconnect destroys Organizinbox's saved credentials and clears your current Inbox Report and cleanup progress."]
          ].map(([title, body]) => (
            <section className="panel p-5" key={title}>
              <h2 className="m-0 text-xl font-extrabold text-[var(--navy)]">{title}</h2>
              <p className="muted mb-0 mt-3">{body}</p>
            </section>
          ))}
        </div>
      </section>
      <section className="section">
        <div className="container">
          <div className="max-w-3xl">
            <p className="eyebrow">Control</p>
            <h2 className="m-0 mt-2 text-3xl font-extrabold text-[var(--navy)]">Connect only for the cleanup workflow.</h2>
            <p className="muted mt-4 leading-8">
              Your Gmail connection stays available while you move between Organizinbox pages. Disconnect destroys the Gmail credentials saved by Organizinbox. Removing Organizinbox from Google Account connected apps is a separate action.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              {!appContext ? (
                <Link className="btn btn-primary focus-ring" href={cta.href}>
                  {cta.label}
                </Link>
              ) : null}
              <Link className="btn btn-secondary focus-ring" href={appContext ? "/app/data-access" : "/data-access"}>
                Data access
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
