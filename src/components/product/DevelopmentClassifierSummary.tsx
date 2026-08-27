"use client";

import { useEffect, useRef, useState } from "react";
import {
  formatGmailLabelCategoryDiagnostic,
  formatMailboxClassifierSummary,
  formatSenderClassifierSummary,
  getClassifierSafetyChecks
} from "@/lib/domain/classifier-summary";
import type { ClassifierScanPerformance, InboxReport, SenderAggregate } from "@/lib/domain/types";

const developmentDiagnosticsEnabled = process.env.NODE_ENV !== "production";

export function DevelopmentMailboxClassifierSummary({
  report,
  performance
}: {
  report: InboxReport;
  performance?: ClassifierScanPerformance;
}) {
  if (!developmentDiagnosticsEnabled || !report.classifierDiagnostics) return null;

  const summary = formatMailboxClassifierSummary(report, performance);
  const gmailDiagnostic = report.classifierDiagnostics.gmailLabelCategory
    ? formatGmailLabelCategoryDiagnostic(report)
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
    </details>
  );
}

export function CopySenderClassifierSummaryButton({ sender }: { sender: SenderAggregate }) {
  if (!developmentDiagnosticsEnabled || !sender.diagnostics) return null;
  return <CopySummaryButton label="Copy sender summary" text={formatSenderClassifierSummary(sender)} />;
}

function CopySummaryButton({ label, text }: { label: string; text: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 1600);
  }

  const buttonLabel = status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label;

  return (
    <button className="btn btn-secondary focus-ring text-sm" onClick={copySummary} type="button">
      <span aria-live="polite">{buttonLabel}</span>
    </button>
  );
}
