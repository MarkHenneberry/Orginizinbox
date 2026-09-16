import Link from "next/link";
import { runtimeConfig } from "@/lib/config";
import { RetentionDisclosure } from "@/components/product/RetentionDisclosure";
import type { PublicPrimaryCta } from "@/lib/server/app-state";

const capabilities = [
  ["Read basic email details", "Yes", "Only the sender, date, read state, and other details needed for your Inbox Report and approved cleanup."],
  ["Read email bodies", "No", "The scanner does not fetch body text or body previews."],
  ["Process subject lines", "Temporarily", "Used only to protect messages that may be important, then discarded. Subject lines are not stored."],
  ["Download attachments", "No", "Attachment contents are not fetched."],
  ["Send email from your mailbox", "No", "Organizinbox does not reply, forward, or send mail."],
  ["Create drafts", "No", "Organizinbox does not create draft messages."],
  ["Permanently delete email", "No", "Approved cleanup moves mail to Trash or Deleted Items only."],
  ["Move mail you approve to Trash / Deleted Items", "When enabled", "Only after you review and confirm the cleanup. Production cleanup is not available yet."],
  ["Store a permanent copy of your inbox", "No", "Inbox Reports and required scan/cleanup state are stored temporarily in encrypted form, then deleted after expiry."],
  ["Sell mailbox data", "Never", "Mailbox-derived data is not for sale."],
  ["Use mailbox data for advertising", "Never", "Mailbox-derived data must not be used for ads or targeting."],
  ["Train AI on mailbox data", "Never", "Mailbox data is not sent to AI training systems."]
];

export function DataAccessContent({ appContext = false, primaryCta }: { appContext?: boolean; primaryCta?: PublicPrimaryCta }) {
  const cta = primaryCta ?? { href: "/connect", label: "Clean my inbox" };

  return (
    <main className="reading-content">
      <section className="section">
        <div className="container">
          <p className="eyebrow">Data access</p>
          <h1 className="section-title mt-3">Temporary reports. Encrypted storage.</h1>
          <p className="muted mt-5 max-w-3xl text-lg leading-8">
            Organizinbox temporarily processes basic email details needed to build your Inbox Report and complete cleanup you approve. Subject lines are used only to protect messages that may be important and are not stored. Google may describe broader Gmail access, but Organizinbox only implements the actions listed below.
          </p>
          <p className="muted mt-4 max-w-3xl text-lg leading-8">
            You pay us. Your inbox doesn&apos;t. Mailbox-derived data is not sold, used for advertising, used for unrelated profiling, sent to third-party analytics, or used for AI training.
          </p>
          <p className="muted mt-4 max-w-3xl text-lg leading-8">
            Disconnect Gmail destroys the access and refresh credentials saved by Organizinbox and clears temporary report and cleanup state. Removing Organizinbox from your Google Account connected apps is available as a separate confirmed action while Gmail is connected.
          </p>
          <RetentionDisclosure />
          {!runtimeConfig.development ? <p className="muted mt-4">Production cleanup is not available. Enabled providers offer read-only scanning.</p> : null}
        </div>
      </section>
      <section className="section bg-white">
        <div className="container">
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="capability-table w-full min-w-[760px] border-collapse text-left text-sm" aria-label="Data access capabilities">
                <thead className="bg-[var(--soft)] text-[var(--navy)]">
                  <tr>
                    <th scope="col" className="p-4">Capability</th>
                    <th scope="col" className="p-4">Organizinbox uses it?</th>
                    <th scope="col" className="p-4">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {capabilities.map(([capability, answer, notes]) => (
                    <tr className="border-t border-[var(--line)]" key={capability}>
                      <td className="p-4 font-bold text-[var(--navy)]">{capability}</td>
                      <td className="p-4">{answer}</td>
                      <td className="p-4 muted">{notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            {!appContext ? (
              <Link className="btn btn-primary focus-ring" href={cta.href}>
                {cta.label}
              </Link>
            ) : null}
            <Link className="btn btn-secondary focus-ring" href={appContext ? "/app/security" : "/security"}>
              Security practices
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
