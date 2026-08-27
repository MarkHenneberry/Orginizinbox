import type { InboxReport } from "@/lib/domain/types";

export function ReportPreview({ report }: { report: InboxReport }) {
  return (
    <div className="panel p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--line)] pb-4">
        <div>
          <p className="eyebrow">Fixture report</p>
          <h2 className="m-0 mt-1 text-2xl font-extrabold text-[var(--navy)]">Your Inbox Report</h2>
        </div>
        <span className="badge">Demo data</span>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Metric label="Emails" value={report.totals.messages.toLocaleString()} />
        <Metric label="You may want to clean" value={report.totals.cleanupCandidates.toLocaleString()} />
        <Metric label="Review" value={report.totals.reviewMessages.toLocaleString()} />
        <Metric label="Protected" value={report.totals.protectedMessages.toLocaleString()} />
        <Metric label="Recurring senders" value={report.totals.recurringSenders.toLocaleString()} />
      </div>
      <div className="mt-5">
        {report.senders.slice(0, 4).map((sender) => (
          <div className="grid grid-cols-[1fr_auto] gap-3 border-t border-[var(--line)] py-3" key={sender.senderKey}>
            <div>
              <p className="m-0 font-bold">{sender.displayName}</p>
              <p className="muted m-0 text-sm">
                {sender.cleanupCandidateCount.toLocaleString()} ready - {sender.reviewMessages.toLocaleString()} review - {sender.protectedMessages.toLocaleString()} protected
              </p>
            </div>
            <p className="m-0 font-extrabold text-[var(--navy)]">{sender.totalMessages.toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--soft)] p-4">
      <p className="muted m-0 text-sm">{label}</p>
      <p className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">{value}</p>
    </div>
  );
}
