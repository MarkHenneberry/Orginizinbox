"use client";

import Link from "next/link";
import { Fragment, useMemo, useReducer, useRef } from "react";
import { ContextBackAction } from "@/components/product/ContextBackAction";
import {
  CopySenderClassifierSummaryButton,
  DevelopmentMailboxClassifierSummary
} from "@/components/product/DevelopmentClassifierSummary";
import {
  categoryLabel,
  protectionReasonText,
  recommendationLabel,
  recommendationReasonText
} from "@/lib/domain/recommendations";
import {
  createSenderWorkspaceState,
  filterAndSortSenders,
  reduceSenderWorkspaceState,
  type SenderSortKey
} from "@/lib/domain/sender-view";
import type {
  CategoryAggregate,
  ClassifierScanPerformance,
  InboxReport,
  ReportSource,
  SenderAggregate
} from "@/lib/domain/types";
import type { ReportRecentCleanupAction } from "@/lib/domain/report-recent-action";
import { formatBytes, formatDate } from "@/lib/format";

export type ReportView = "overview" | "senders" | "categories" | "old-mail";

const viewLinks: Array<{ view: ReportView; label: string }> = [
  { view: "overview", label: "Overview" },
  { view: "senders", label: "Senders" },
  { view: "categories", label: "Categories" },
  { view: "old-mail", label: "Old Mail" }
];

const senderSortOptions: Array<{ value: SenderSortKey; label: string }> = [
  { value: "emails", label: "Most emails" },
  { value: "ready", label: "Most suggested" },
  { value: "unread", label: "Most unread" },
  { value: "oldest", label: "Oldest" },
  { value: "storage", label: "Storage" },
  { value: "recommendation", label: "Recommendation" }
];

const developmentDiagnosticsEnabled = process.env.NODE_ENV !== "production";

export function InboxReportView({
  report,
  reportStale,
  recentCleanupAction,
  source,
  view,
  backHref,
  scanPerformance
}: {
  report: InboxReport;
  reportStale: boolean;
  recentCleanupAction?: ReportRecentCleanupAction;
  source: ReportSource;
  view: ReportView;
  backHref: string;
  scanPerformance?: ClassifierScanPerformance;
}) {
  return (
    <main className="py-8">
      <div className="container">
        <ContextBackAction className="mb-5" href={backHref} label="Back to Organizinbox" />
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="eyebrow">{sourceLabel(source)}</p>
            <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">Your Inbox Report</h1>
            <p className="muted mt-2">
              {report.fixtureMode
                ? "Development fixture data. No Gmail or Outlook account is connected."
                : "See the senders, categories, and old email filling your inbox."}
            </p>
          </div>
          {report.totals.cleanupCandidates > 0 ? (
            <Link href="/app/cleanup" className="btn btn-primary focus-ring">
              Review cleanup
            </Link>
          ) : (
            <span className="muted text-sm font-bold">Nothing recommended for cleanup</span>
          )}
        </div>

        {recentCleanupAction ? (
          <PostUndoReportNotice action={recentCleanupAction} />
        ) : reportStale ? (
          <section className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-4">
            <h2 className="m-0 text-lg font-extrabold text-[var(--navy)]">Inbox changed since this report was generated</h2>
            <p className="muted m-0 mt-1">Scan again before choosing more email to clean.</p>
            <Link href="/app/scan" className="btn btn-secondary focus-ring mt-3">
              Rescan inbox
            </Link>
          </section>
        ) : null}

        <DevelopmentMailboxClassifierSummary performance={scanPerformance} report={report} />

        <nav className="mb-6 flex flex-wrap gap-2" aria-label="Inbox report views">
          {viewLinks.map((item) => (
            <Link
              className={`rounded-md border px-4 py-2 text-sm font-bold ${
                view === item.view ? "border-[var(--teal)] bg-[var(--soft)] text-[var(--navy)]" : "border-[var(--line)] bg-white text-[var(--muted)]"
              }`}
              href={item.view === "overview" ? "/app/report" : `/app/report?view=${item.view}`}
              key={item.view}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {view === "overview" ? <OverviewView report={report} /> : null}
        {view === "senders" ? <SendersView report={report} /> : null}
        {view === "categories" ? <CategoriesView categories={report.categories} /> : null}
        {view === "old-mail" ? <OldMailView senders={report.senders} /> : null}

        {report.totals.cleanupCandidates > 0 ? (
          <div className="mt-8 flex justify-end">
            <Link href="/app/cleanup" className="btn btn-primary focus-ring">
              Review cleanup
            </Link>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function PostUndoReportNotice({ action }: { action: ReportRecentCleanupAction }) {
  const fullUndo = action.outcome === "undo_complete";
  const afterReport = action.reportRelation === "report_after_cleanup";
  return (
    <section className="mb-6 rounded-md border border-emerald-300 bg-emerald-50 p-4">
      <h2 className="m-0 text-lg font-extrabold text-[var(--navy)]">
        {fullUndo
          ? afterReport ? "Cleanup was undone after this report was generated" : "Cleanup undone"
          : "Cleanup restore completed with unresolved messages"}
      </h2>
      <p className="muted m-0 mt-1">
        {action.verifiedRestoredCount.toLocaleString()} messages were restored
        {!fullUndo
          ? `; ${action.failedRestoreCount.toLocaleString()} failed and ${action.uncertainRestoreCount.toLocaleString()} remain uncertain.`
          : "."}
      </p>
      <p className="muted m-0 mt-1">
        {afterReport
          ? "Rescan to include the restoration and any other inbox changes."
          : "This report is based on your earlier scan. Rescan to include any other inbox changes."}
      </p>
      <Link href="/app/scan" className="btn btn-secondary focus-ring mt-3">Rescan inbox</Link>
    </section>
  );
}

function OverviewView({ report }: { report: InboxReport }) {
  return (
    <>
      <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-4" aria-label="Inbox report summary">
        <Summary label="Emails" value={report.totals.messages.toLocaleString()} />
        <Summary label="Emails you may want to clean" value={report.totals.cleanupCandidates.toLocaleString()} />
        <Summary label="Review" value={report.totals.reviewMessages.toLocaleString()} />
        <Summary label="Protected" value={report.totals.protectedMessages.toLocaleString()} />
        <Summary label="Unread older than one year" value={report.totals.unreadOlderThanOneYear.toLocaleString()} />
        <Summary label="Recurring senders" value={report.totals.recurringSenders.toLocaleString()} />
        <Summary label="Potential recovery" value={formatBytes(report.totals.estimatedRecoverableBytes)} />
      </section>
      <section className="mt-6 grid gap-4 md:grid-cols-3" aria-label="Category summary">
        {report.categories.slice(0, 9).map((category) => (
          <CategoryCard category={category} key={category.category} />
        ))}
      </section>
    </>
  );
}

function SendersView({ report }: { report: InboxReport }) {
  const detailPaneRef = useRef<HTMLDivElement>(null);
  const [workspace, dispatch] = useReducer(
    (state: ReturnType<typeof createSenderWorkspaceState>, action: Parameters<typeof reduceSenderWorkspaceState>[2]) =>
      reduceSenderWorkspaceState(report.senders, state, action),
    report.senders,
    createSenderWorkspaceState
  );

  const visibleSenders = useMemo(
    () => filterAndSortSenders(report.senders, workspace.search, workspace.sortKey),
    [report.senders, workspace.search, workspace.sortKey]
  );
  const selectedSender =
    visibleSenders.find((sender) => sender.senderKey === workspace.selectedSenderKey) ?? visibleSenders[0];

  function selectSender(senderKey: string) {
    dispatch({ type: "select", senderKey });
    detailPaneRef.current?.scrollTo({ top: 0 });
  }

  return (
    <section
      className="grid gap-5 lg:h-[calc(100dvh-12rem)] lg:min-h-[36rem] lg:max-h-[64rem] lg:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.75fr)]"
      data-layout="sender-workspace"
    >
      <div className="panel min-w-0 overflow-hidden lg:flex lg:min-h-0 lg:flex-col" data-pane="sender-browser">
        <div className="grid shrink-0 gap-4 border-b border-[var(--line)] bg-white p-5" data-sender-controls="sticky">
          <div>
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Senders</h2>
            <p className="muted m-0 mt-1">Search and compare every sender group in this report.</p>
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-bold text-[var(--navy)]" htmlFor="sender-search">
              Search senders
            </label>
            <input
              className="focus-ring min-h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-base"
              id="sender-search"
              onChange={(event) => dispatch({ type: "search", search: event.target.value })}
              placeholder="Name, domain, or sender identity"
              type="search"
              value={workspace.search}
            />
          </div>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2 text-sm font-bold text-[var(--navy)]">Sort senders</legend>
            <div className="flex flex-wrap gap-2">
              {senderSortOptions.map((option) => (
                <button
                  aria-pressed={workspace.sortKey === option.value}
                  className={`rounded-md border px-3 py-2 text-sm font-bold focus-ring ${workspace.sortKey === option.value ? "border-[var(--teal)] bg-[var(--soft)] text-[var(--navy)]" : "border-[var(--line)] bg-white text-[var(--muted)]"}`}
                  key={option.value}
                  onClick={() => dispatch({ type: "sort", sortKey: option.value })}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
          <p className="muted m-0 text-sm" aria-live="polite">
            {visibleSenders.length.toLocaleString()} of {report.senders.length.toLocaleString()} sender groups
          </p>
        </div>
        <div className="grid gap-3 p-4 lg:hidden" aria-label="Sender groups" data-mobile-layout="stacked">
          {visibleSenders.map((sender) => (
            <Fragment key={sender.senderKey}>
              <SenderMobileRow
                selected={sender.senderKey === selectedSender?.senderKey}
                sender={sender}
                onSelect={() => selectSender(sender.senderKey)}
              />
              {sender.senderKey === selectedSender?.senderKey ? (
                <SenderDetail allSenders={report.senders} embedded sender={sender} />
              ) : null}
            </Fragment>
          ))}
        </div>
        <div
          aria-label="Scrollable sender list"
          className="focus-ring hidden min-h-0 flex-1 overflow-auto overscroll-contain lg:block"
          data-scroll-region="sender-list"
          tabIndex={0}
        >
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--soft)] text-[var(--navy)]">
              <tr>
                <th className="p-4">Sender</th>
                <th className="p-4 text-right">Emails</th>
                <th className="p-4 text-right">Suggested</th>
                <th className="p-4 text-right">Review</th>
                <th className="p-4 text-right">Protected</th>
                <th className="p-4">Oldest</th>
                <th className="p-4 text-right">Suggested storage</th>
                <th className="p-4">Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {visibleSenders.map((sender) => {
                const selected = sender.senderKey === selectedSender?.senderKey;
                return (
                  <tr
                    className={`cursor-pointer border-t border-[var(--line)] hover:bg-[var(--soft)] ${selected ? "bg-[var(--soft)] shadow-[inset_4px_0_0_var(--teal)]" : "bg-white"}`}
                    data-selected={selected ? "true" : "false"}
                    key={sender.senderKey}
                    onClick={() => selectSender(sender.senderKey)}
                  >
                    <td className="p-4">
                      <button
                        aria-pressed={selected}
                        className="focus-ring flex w-full items-start justify-between gap-3 text-left font-bold text-[var(--navy)]"
                        type="button"
                      >
                        <span>{sender.displayName}</span>
                        <span className={selected ? "text-xs font-bold" : "invisible text-xs"} aria-hidden={!selected}>
                          Selected
                        </span>
                      </button>
                      <p className="muted m-0 text-xs">{senderIdentityLabel(sender)}</p>
                    </td>
                    <td className="p-4 text-right font-bold">{sender.totalMessages.toLocaleString()}</td>
                    <td className="p-4 text-right">{sender.cleanupCandidateCount.toLocaleString()}</td>
                    <td className="p-4 text-right">{sender.reviewMessages.toLocaleString()}</td>
                    <td className="p-4 text-right">{sender.protectedMessages.toLocaleString()}</td>
                    <td className="p-4">{formatDate(sender.oldestMessageAt)}</td>
                    <td className="p-4 text-right">{formatBytes(sender.estimatedEligibleBytes)}</td>
                    <td className="p-4">
                      <span className="badge">{recommendationLabel(sender.cleanupConfidence)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visibleSenders.length === 0 ? (
          <div className="border-t border-[var(--line)] p-5">
            <p className="m-0 font-bold text-[var(--navy)]">No sender groups match this search.</p>
          </div>
        ) : null}
      </div>

      <div
        aria-label="Selected sender detail"
        className="focus-ring hidden min-h-0 overflow-y-auto overscroll-contain lg:block"
        data-pane="sender-detail"
        ref={detailPaneRef}
        tabIndex={0}
      >
        {selectedSender ? (
          <SenderDetail allSenders={report.senders} sender={selectedSender} />
        ) : (
          <EmptySenderDetail filtered={Boolean(workspace.search)} />
        )}
      </div>
    </section>
  );
}

function SenderMobileRow({
  sender,
  selected,
  onSelect
}: {
  sender: SenderAggregate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`grid gap-3 rounded-md border bg-white p-4 text-left focus-ring ${selected ? "border-[var(--teal)] shadow-[inset_4px_0_0_var(--teal)]" : "border-[var(--line)]"}`}
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      type="button"
    >
      <span className="flex items-start justify-between gap-3">
        <span>
          <span className="block font-bold text-[var(--navy)]">{sender.displayName}</span>
          <span className="muted block text-xs">{senderIdentityLabel(sender)}</span>
        </span>
        <span className={selected ? "text-xs font-bold text-[var(--navy)]" : "invisible text-xs"} aria-hidden={!selected}>
          Selected
        </span>
      </span>
      <span className="grid grid-cols-4 gap-2 text-center text-xs">
        <CompactMetric label="Total" value={sender.totalMessages} />
        <CompactMetric label="Suggested" value={sender.cleanupCandidateCount} />
        <CompactMetric label="Review" value={sender.reviewMessages} />
        <CompactMetric label="Protected" value={sender.protectedMessages} />
      </span>
      <span className="flex items-center justify-between gap-3">
        <span className="muted text-xs">Oldest {formatDate(sender.oldestMessageAt)}</span>
        <span className="badge">{recommendationLabel(sender.cleanupConfidence)}</span>
      </span>
    </button>
  );
}

function CategoriesView({ categories }: { categories: CategoryAggregate[] }) {
  return (
    <section className="grid gap-4 md:grid-cols-3" aria-label="Category analysis">
      {categories.map((category) => (
        <CategoryCard category={category} key={category.category} />
      ))}
    </section>
  );
}

function OldMailView({ senders }: { senders: SenderAggregate[] }) {
  const oldSenders = senders.filter((sender) => sender.oldMessages > 0).slice(0, 30);
  return (
    <section>
      <div className="panel overflow-hidden">
        {oldSenders.length ? (
          oldSenders.map((sender) => (
            <div className="grid gap-3 border-b border-[var(--line)] p-5 md:grid-cols-[1fr_auto_auto]" key={sender.senderKey}>
              <div>
                <strong>{sender.displayName}</strong>
                <p className="muted m-0 text-xs">{sender.senderSecondaryLabel ?? sender.domain ?? categoryLabel(sender.classification)}</p>
              </div>
              <span>{sender.oldMessages.toLocaleString()} older than six months</span>
              <span className="muted">Oldest {formatDate(sender.oldestMessageAt)}</span>
            </div>
          ))
        ) : (
          <div className="p-5">
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">No old mail groups</h2>
            <p className="muted">The active report does not contain enough older-message groups to show here.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function CategoryCard({ category }: { category: CategoryAggregate }) {
  return (
    <section className="panel p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="m-0 text-lg font-extrabold text-[var(--navy)]">{categoryLabel(category.category)}</h2>
        <span className="badge">{recommendationLabel(category.topRecommendation)}</span>
      </div>
      <p className="mt-4 text-3xl font-extrabold text-[var(--navy)]">{category.totalMessages.toLocaleString()}</p>
      <p className="muted mt-2 text-sm">{recommendationDescription(category.topRecommendation)}</p>
      <dl className="grid gap-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="muted">Unread</dt>
          <dd className="m-0 font-bold">{category.unreadMessages.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="muted">Older than six months</dt>
          <dd className="m-0 font-bold">{category.oldMessages.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="muted">Suggested</dt>
          <dd className="m-0 font-bold">{category.cleanupCandidateCount.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="muted">Review</dt>
          <dd className="m-0 font-bold">{category.reviewMessages.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="muted">Protected</dt>
          <dd className="m-0 font-bold">{category.protectedMessages.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="muted">Estimated size</dt>
          <dd className="m-0 font-bold">{formatBytes(category.estimatedBytes)}</dd>
        </div>
      </dl>
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel p-5">
      <p className="muted m-0 text-sm">{label}</p>
      <p className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">{value}</p>
    </div>
  );
}

function SenderDetail({
  sender,
  allSenders,
  embedded = false
}: {
  sender: SenderAggregate;
  allSenders: SenderAggregate[];
  embedded?: boolean;
}) {
  return (
    <aside
      className={embedded ? "border-y border-[var(--line)] bg-[var(--soft)] p-5" : "panel min-h-full p-5"}
      data-mobile-detail={embedded ? "inline" : undefined}
    >
      <p className="eyebrow">Sender detail</p>
      <h2 className="m-0 mt-2 text-3xl font-extrabold text-[var(--navy)]">{sender.displayName}</h2>
      <p className="muted">
        {sender.senderSecondaryLabel ?? sender.domain ?? "Sender"} - {sender.totalMessages.toLocaleString()} emails
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-center text-sm">
        <SenderMetric label="Total" value={sender.totalMessages} />
        <SenderMetric label="Suggested" value={sender.cleanupCandidateCount} />
        <SenderMetric label="Review" value={sender.reviewMessages} />
        <SenderMetric label="Protected" value={sender.protectedMessages} />
      </dl>
      <p className="mt-4 font-bold text-[var(--navy)]">{recommendationLabel(sender.cleanupConfidence)}</p>
      <p className="muted mt-1">{recommendationDescription(sender.cleanupConfidence)}</p>
      <h3 className="mt-6 text-lg font-extrabold text-[var(--navy)]">Why we recommend this</h3>
      <ul className="grid gap-2 pl-5">
        {sender.reasonCodes.slice(0, 3).map((reason) => (
          <li key={reason}>{recommendationReasonText(reason)}</li>
        ))}
      </ul>
      {sender.diagnostics ? (
        <DevelopmentClassifierInspection
          matchingSenderGroups={allSenders.filter(
            (candidate) => candidate.displayName.toLocaleLowerCase("en-US") === sender.displayName.toLocaleLowerCase("en-US")
          )}
          sender={sender}
        />
      ) : null}
      <div className="mt-6 rounded-lg border border-[var(--line)] bg-[var(--soft)] p-4">
        <p className="m-0 font-extrabold text-[var(--navy)]">Protected</p>
        <p className="m-0 mt-2 text-3xl font-extrabold text-[var(--navy)]">{sender.protectedMessages.toLocaleString()}</p>
        <p className="muted m-0 mt-2 text-sm">
          Organizinbox leaves messages alone when we find signs they may be important. {" "}
          {sender.protectionReasons[0]
            ? protectionReasonText(sender.protectionReasons[0])
            : "Messages that do not meet the cleanup rules stay out."} {" "}
          When we&apos;re unsure, we leave them alone.
        </p>
      </div>
      {canCleanSender(sender) ? (
        <Link href="/app/cleanup" className="btn btn-primary focus-ring mt-6 w-full">
          Review {sender.cleanupCandidateCount.toLocaleString()} emails
        </Link>
      ) : (
        <div className="mt-6 rounded-md border border-[var(--line)] bg-[var(--soft)] p-4 text-center">
          <p className="m-0 font-extrabold text-[var(--navy)]">Nothing recommended for cleanup</p>
          <p className="muted m-0 mt-1 text-sm">We found signs these messages should be left alone.</p>
        </div>
      )}
    </aside>
  );
}

function DevelopmentClassifierInspection({
  sender,
  matchingSenderGroups
}: {
  sender: SenderAggregate;
  matchingSenderGroups: SenderAggregate[];
}) {
  const diagnostics = sender.diagnostics;
  if (!developmentDiagnosticsEnabled || !diagnostics) return null;
  const signals = diagnostics.messageSignals;
  const readySignals = diagnostics.readyStrongSignals;

  return (
    <details className="mt-6 border-t border-[var(--line)] pt-4 text-sm">
      <summary className="cursor-pointer font-extrabold text-[var(--navy)]">Classifier inspection (development)</summary>
      <p className="muted mt-2">Aggregate metadata counts only. No message IDs, conversations, raw headers, or content.</p>
      <div className="mt-3">
        <CopySenderClassifierSummaryButton sender={sender} />
      </div>
      {matchingSenderGroups.length > 1 ? (
        <div className="mt-4 rounded-md border border-[var(--line)] bg-[var(--soft)] p-3">
          <h4 className="m-0 font-extrabold text-[var(--navy)]">Matching sender groups</h4>
          <ul className="mb-0 mt-2 grid gap-1 pl-5">
            {matchingSenderGroups.map((candidate) => (
              <li key={candidate.senderKey}>
                {senderIdentityLabel(candidate)} - Total {candidate.totalMessages.toLocaleString()} - Starred {candidate.diagnostics?.messageSignals.starredMessages.toLocaleString() ?? "0"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <h4 className="mb-2 mt-4 font-extrabold text-[var(--navy)]">Final states</h4>
      <dl className="grid gap-2">
        <DiagnosticRow label="Total" value={diagnostics.totalMessages} />
        <DiagnosticRow label="Suggested" value={diagnostics.readyMessages} />
        <DiagnosticRow label="Review" value={diagnostics.reviewMessages} />
        <DiagnosticRow label="Protected" value={diagnostics.protectedMessages} />
      </dl>
      <h4 className="mb-2 mt-4 font-extrabold text-[var(--navy)]">Messages with safe metadata signals</h4>
      <dl className="grid gap-2">
        <DiagnosticRow label="Flagged / starred" value={signals.starredMessages} />
        <DiagnosticRow label="Important" value={signals.importantMessages} />
        <DiagnosticRow label="Recent" value={signals.recentMessages} />
        <DiagnosticRow label="Personal" value={signals.personalMessages} />
        <DiagnosticRow label="Participated conversation" value={signals.participatedConversationMessages} />
        <DiagnosticRow label="User label" value={signals.userLabelMessages} />
        <DiagnosticRow
          label="Subject protection"
          value={(signals.transactionalSubjectMessages ?? 0) + (signals.securityAccountSubjectMessages ?? 0)}
        />
        <DiagnosticRow label="List-Id" value={signals.listIdMessages} />
        <DiagnosticRow label="List-Unsubscribe" value={signals.listUnsubscribeMessages} />
        <DiagnosticRow label="Precedence bulk / list" value={signals.precedenceBulkOrListMessages} />
        <DiagnosticRow label="Promotions" value={signals.promotionsMessages} />
        <DiagnosticRow label="Updates" value={signals.updatesMessages} />
        <DiagnosticRow label="Social" value={signals.socialMessages} />
        <DiagnosticRow label="Auto-Submitted" value={signals.autoSubmittedMessages} />
      </dl>
      <h4 className="mb-2 mt-4 font-extrabold text-[var(--navy)]">Strong signals on Suggested messages</h4>
      <dl className="grid gap-2">
        <DiagnosticRow label="List-Id" value={readySignals.listIdMessages} />
        <DiagnosticRow label="List-Unsubscribe" value={readySignals.listUnsubscribeMessages} />
        <DiagnosticRow label="Precedence bulk / list" value={readySignals.precedenceBulkOrListMessages} />
        <DiagnosticRow label="Promotions" value={readySignals.promotionsMessages} />
        <DiagnosticRow label="Suggested with hard protection" value={readySignals.withHardProtectionMessages ?? 0} />
        <DiagnosticRow label="Suggested without a strong signal" value={readySignals.withoutStrongSignalMessages} />
      </dl>
    </details>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="muted">{label}</dt>
      <dd className="m-0 font-bold text-[var(--navy)]">{value.toLocaleString()}</dd>
    </div>
  );
}

function SenderMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-[var(--line)] p-2">
      <dt className="muted">{label}</dt>
      <dd className="m-0 mt-1 font-extrabold text-[var(--navy)]">{value.toLocaleString()}</dd>
    </div>
  );
}

function CompactMetric({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-md bg-[var(--soft)] p-2">
      <span className="muted block">{label}</span>
      <span className="mt-1 block font-extrabold text-[var(--navy)]">{value.toLocaleString()}</span>
    </span>
  );
}

function canCleanSender(sender: SenderAggregate) {
  return (
    sender.cleanupCandidateCount > 0 &&
    (sender.cleanupConfidence === "high" || sender.cleanupConfidence === "very_high")
  );
}

function senderIdentityLabel(sender: SenderAggregate) {
  return (
    sender.diagnosticSenderIdentity ??
    sender.senderSecondaryLabel ??
    sender.domain ??
    categoryLabel(sender.classification)
  );
}

function EmptySenderDetail({ filtered = false }: { filtered?: boolean }) {
  return (
    <aside className="panel min-h-full p-5">
      <p className="eyebrow">Sender detail</p>
      <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">
        {filtered ? "No senders match your search." : "No sender data yet"}
      </h2>
      <p className="muted">
        {filtered
          ? "Change or clear the search to choose a sender."
          : "Run a scan with at least one message to populate sender detail."}
      </p>
    </aside>
  );
}

function sourceLabel(source: ReportSource) {
  return {
    fixture: "DEVELOPMENT FIXTURE",
    "gmail-live": "Gmail",
    "microsoft-live": "Outlook"
  }[source];
}

function recommendationDescription(recommendation: SenderAggregate["cleanupConfidence"]) {
  return {
    very_high: "Several independent bulk-mail signals agree.",
    high: "Recurring old mail has strong bulk-mail evidence.",
    review: "Review only. No messages in this group are suggested for cleanup.",
    keep: "We found signs these messages may be important."
  }[recommendation];
}
