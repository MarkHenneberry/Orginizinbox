import Link from "next/link";
import { BackToReportAction } from "@/components/product/AppContextActions";
import { RetentionDisclosure } from "@/components/product/RetentionDisclosure";
import { getOptionalActiveReportState } from "@/lib/server/report-state";

export default async function AppHelpPage() {
  const activeReport = await getOptionalActiveReportState();
  return <main className="settings-page"><div className="container help-width">
    <BackToReportAction activeReport={activeReport} />
    <header className="settings-heading"><h1>Help</h1><p>Quick answers about scanning, cleanup and your data.</p></header>
    <section className="help-group"><h2>Getting started</h2>
      <details><summary>How scanning works</summary><div><p>Connect Gmail or Outlook and scan the whole inbox first. You do not need to choose senders or a date range. Scanning does not move or delete anything.</p><p>Review your Inbox Report, choose what to clean, confirm cleanup, then check the result. Scan again to see what remains.</p></div></details>
      <details><summary>Understanding Suggested, Review and Protected</summary><div><p>Suggested messages are candidates for cleanup. Review messages need a closer look. Protected messages are left alone.</p><p>We protect recent, starred, flagged, and important messages, plus messages showing signs of personal, account, or billing information. These checks cannot determine the value of every email. Review your selection; when we&apos;re unsure, we leave a message alone.</p></div></details>
    </section>
    <section className="help-group"><h2>Cleanup &amp; Undo</h2>
      <details><summary>What cleanup does</summary><div><p>Review suggested sender groups and messages, then choose what you want moved. Where cleanup is available, open Review Cleanup and confirm your selection. Organizinbox runs final safety checks and moves only approved messages to Gmail Trash or Outlook Deleted Items.</p><p>Organizinbox never permanently deletes email. Your provider&apos;s retention rules still apply. One credit is spent only for a verified move; scanning, exclusions, failed moves and uncertain moves do not spend credits.</p></div></details>
      <details><summary>How Undo works</summary><div><p>Use Undo within the displayed deadline. Recovery Undo restores only the messages already verified as moved when a cleanup stops partway. Uncertain results stay unresolved.</p><p>Undo needs Organizinbox&apos;s temporary restoration state. Once it expires, Undo is unavailable. A verified successful Undo returns the corresponding credit.</p></div></details>
      <details><summary>Disconnecting your inbox</summary><div><p>For Gmail and Outlook, use any available Undo or Recovery Undo before disconnecting. It needs temporary restoration state, which disconnect removes. Reconnecting will not bring it back. The cleanup result shows your actual Undo deadline.</p><p>Disconnect destroys Organizinbox&apos;s saved credentials and temporary inbox state for that provider. It does not restore moved email.</p><p className="text-sm">For Gmail, removing Google authorization is a separate action in Account. You can also <a className="text-link" href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">manage connected apps in your Google Account (opens in a new tab)</a>.</p></div></details>
    </section>
    <section className="help-group"><h2>Privacy &amp; safety</h2>
      <details><summary>What Organizinbox can access</summary><div><p>The scan uses basic email details and selected headers to group messages and apply protection checks. Subject lines are used temporarily to protect messages that may be important, then discarded.</p></div></details>
      <details><summary>What Organizinbox never reads</summary><div><p>Normal scans do not read email bodies or download attachments. Mailbox data is not sold, used for advertising or sent to AI training systems.</p></div></details>
      <details><summary>Security and data retention</summary><div><RetentionDisclosure /></div></details>
    </section>
    <section className="help-more"><h2>Need more detail?</h2><nav aria-label="More help" className="flex flex-wrap gap-3">
      <Link className="btn btn-secondary focus-ring" href="/app/security">Security</Link>
      <Link className="btn btn-secondary focus-ring" href="/app/data-access">Data Access</Link>
      <Link className="btn btn-secondary focus-ring" href="/app/privacy">Privacy</Link>
    </nav></section>
  </div></main>;
}
