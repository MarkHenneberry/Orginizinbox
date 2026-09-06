"use client";

import { useEffect, useReducer, useRef } from "react";
import {
  COPY_FEEDBACK_DURATION_MS,
  copyFeedbackLabel,
  reduceCopyFeedback
} from "@/lib/domain/copy-feedback";
import {
  formatGmailLabelCategoryDiagnostic,
  formatMailboxClassifierSummary,
  formatSenderClassifierSummary,
  getClassifierSafetyChecks
} from "@/lib/domain/classifier-summary";
import { formatOutlookScanSummary } from "@/lib/domain/outlook-scan-summary";
import type {
  ClassifierScanPerformance,
  InboxReport,
  OutlookScanDiagnostic,
  SenderAggregate
} from "@/lib/domain/types";

const developmentDiagnosticsEnabled = process.env.NODE_ENV !== "production";

export function DevelopmentMailboxClassifierSummary({
  report,
  performance,
  outlookDiagnostic
}: {
  report: InboxReport;
  performance?: ClassifierScanPerformance;
  outlookDiagnostic?: OutlookScanDiagnostic;
}) {
  if (!developmentDiagnosticsEnabled || !report.classifierDiagnostics) return null;

  const summary = formatMailboxClassifierSummary(report, performance);
  const gmailDiagnostic = report.classifierDiagnostics.gmailLabelCategory
    ? formatGmailLabelCategoryDiagnostic(report)
    : undefined;
  const outlookSummary = outlookDiagnostic
    ? formatOutlookScanSummary(report, outlookDiagnostic)
    : undefined;
  const safety = getClassifierSafetyChecks(report);
  const unsafe = Object.values(safety).some((count) => count > 0);

  return (
    <details
      className={`panel mb-6 p-5 ${unsafe ? "border-red-500 bg-red-50" : ""}`}
      data-classifier-safety={unsafe ? "warning" : "clear"}
    >
      <summary className="cursor-pointer font-extrabold text-[var(--navy)]">
        Classifier summary (development)
      </summary>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="muted m-0 text-sm">Aggregate counts only. Reason counts can overlap.</p>
        <CopySummaryButton label="Copy summary" text={summary} />
      </div>
      <pre className="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--line)] bg-white p-4 text-xs leading-5 text-[var(--foreground)]">
        {summary}
      </pre>
      {gmailDiagnostic ? (
        <section className="mt-5 border-t border-[var(--line)] pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="m-0 text-base font-extrabold text-[var(--navy)]">Gmail label/category diagnostic</h3>
              <p className="muted m-0 mt-1 text-sm">Aggregate input counts only. User-label names are excluded.</p>
            </div>
            <CopySummaryButton label="Copy Gmail diagnostic" text={gmailDiagnostic} />
          </div>
          <pre className="mt-4 max-h-[24rem] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--line)] bg-white p-4 text-xs leading-5 text-[var(--foreground)]">
            {gmailDiagnostic}
          </pre>
        </section>
      ) : null}
      {outlookSummary ? (
        <section className="mt-5 border-t border-[var(--line)] pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="m-0 text-base font-extrabold text-[var(--navy)]">Outlook scan diagnostic</h3>
              <p className="muted m-0 mt-1 text-sm">Aggregate development snapshot only.</p>
            </div>
            <CopySummaryButton
              label="Copy Outlook scan summary"
              snapshotKey={outlookDiagnostic?.snapshotId ?? outlookSummary}
              text={outlookSummary}
            />
          </div>
          <pre className="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--line)] bg-white p-4 text-xs leading-5 text-[var(--foreground)]">
            {outlookSummary}
          </pre>
        </section>
      ) : null}
    </details>
  );
}

export function CopySenderClassifierSummaryButton({ sender }: { sender: SenderAggregate }) {
  if (!developmentDiagnosticsEnabled || !sender.diagnostics) return null;
  return <CopySummaryButton label="Copy sender summary" text={formatSenderClassifierSummary(sender)} />;
}

export function CopySummaryButton({
  label,
  text,
  snapshotKey = text
}: {
  label: string;
  text: string;
  snapshotKey?: string;
}) {
  const [feedback, dispatch] = useReducer(reduceCopyFeedback, {
    snapshotKey,
    status: "idle"
  });
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(resetTimer.current);
    dispatch({ type: "snapshot_changed", snapshotKey });
    return () => clearTimeout(resetTimer.current);
  }, [snapshotKey]);

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(text);
      dispatch({ type: "copy_succeeded", snapshotKey });
    } catch {
      dispatch({ type: "copy_failed", snapshotKey });
    }
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(
      () => dispatch({ type: "reset", snapshotKey }),
      COPY_FEEDBACK_DURATION_MS
    );
  }

  const buttonLabel = copyFeedbackLabel(feedback, snapshotKey, label);

  return (
    <button className="btn btn-secondary focus-ring text-sm" onClick={copySummary} type="button">
      <span aria-live="polite">{buttonLabel}</span>
    </button>
  );
}
