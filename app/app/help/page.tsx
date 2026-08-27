import Link from "next/link";
import { BackToReportAction } from "@/components/product/AppContextActions";
import { getOptionalActiveReportState } from "@/lib/server/report-state";

export default async function AppHelpPage() {
  const activeReport = await getOptionalActiveReportState();

  return (
    <main className="py-8">
      <div className="container max-w-4xl">
        <BackToReportAction activeReport={activeReport} />
        <p className="eyebrow">Help</p>
        <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">Help</h1>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <section className="panel p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">What Organizinbox is doing</h2>
            <p className="muted">The scan uses basic email details to find recurring senders, old mail, and likely clutter. Subject lines are processed temporarily only to protect messages that may be important. It does not read email bodies or download attachments.</p>
          </section>
          <section className="panel p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">What is protected</h2>
            <p className="muted">Recent, personal, account, billing, starred, flagged, and important messages stay out of cleanup recommendations. When we&apos;re unsure, we leave a message alone.</p>
          </section>
          <section className="panel p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">What cleanup will do</h2>
            <p className="muted">Cleanup moves only messages you approve to Trash. Nothing is permanently deleted.</p>
          </section>
          <section className="panel p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Disconnecting Gmail</h2>
            <p className="muted">
              Disconnect Gmail destroys Organizinbox&apos;s saved credentials and temporary inbox state. To remove Organizinbox from Google Account connected apps after disconnecting, manage the connection directly at Google.
            </p>
            <a
              className="focus-ring mt-3 inline-flex rounded-md py-2 text-sm font-bold text-[var(--teal-dark)] hover:underline"
              href="https://myaccount.google.com/connections"
              rel="noreferrer"
              target="_blank"
            >
              Manage connected apps in your Google Account (opens in a new tab)
            </a>
          </section>
          <section className="panel p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">More detail</h2>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link className="btn btn-secondary focus-ring" href="/app/security">
                Security
              </Link>
              <Link className="btn btn-secondary focus-ring" href="/app/data-access">
                Data Access
              </Link>
              <Link className="btn btn-secondary focus-ring" href="/app/privacy">
                Privacy
              </Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
