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
            <p className="muted">Connect Gmail or Outlook and scan the whole inbox first. You do not need to choose senders or a date range. Scanning does not move or delete anything. Your Inbox Report shows Suggested, Review and Protected messages, so you can see where the clutter comes from and choose what to clean.</p>
            <p className="muted">The scan uses basic email details. Subject lines are used temporarily to protect messages that may be important. It does not read email bodies or download attachments.</p>
          </section>
          <section className="panel p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">What is protected</h2>
            <p className="muted">We protect recent, starred, flagged, and important messages, plus messages showing signs of personal, account, or billing information. These checks cannot determine the value of every email. Review your selection; when we&apos;re unsure, we leave a message alone.</p>
          </section>
          <section className="panel p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">What cleanup will do</h2>
            <p className="muted">Review suggested sender groups and messages, then choose what you want moved. Where cleanup is available, open Review Cleanup and confirm your selection. Organizinbox runs final safety checks and moves only approved messages to Gmail Trash or Outlook Deleted Items.</p>
            <p className="muted">Check the result. Use Undo within the displayed deadline if needed, or scan again to see what remains. Organizinbox never permanently deletes email. Your provider&apos;s retention rules still apply.</p>
          </section>
          <section className="panel p-6">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Disconnecting Gmail</h2>
            <p className="muted">For Gmail and Outlook, use any available Undo or Recovery Undo before disconnecting. It needs temporary restoration state, which disconnect removes. Reconnecting will not bring it back. The cleanup result shows your actual Undo deadline.</p>
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
