"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { OperationStatus } from "@/components/product/OperationStatus";

type ScanProgress = {
  scanId: string;
  provider: "gmail";
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  processed: number;
  mailboxExists?: number;
  startedAt: number;
  errors: string[];
};

export function GmailScanClient({ initialProgress }: { initialProgress: ScanProgress | null }) {
  const [progress, setProgress] = useState<ScanProgress | null>(initialProgress);
  const [pending, setPending] = useState(false);
  const [operationMode, setOperationMode] = useState<"scan" | "rescan">("scan");
  const [operationStartedAt, setOperationStartedAt] = useState<number | undefined>(initialProgress?.startedAt);
  const pendingRef = useRef(false);

  const isRunning = progress?.status === "running";
  const working = pending || isRunning;
  const percent = useMemo(() => {
    if (!progress?.mailboxExists) return 0;
    return Math.min(100, Math.round((progress.processed / progress.mailboxExists) * 100));
  }, [progress]);

  useEffect(() => {
    if (!isRunning) return;
    const interval = window.setInterval(async () => {
      const response = await fetch("/api/app/gmail-scan/status", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { progress: ScanProgress | null };
      setProgress(payload.progress);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isRunning]);

  async function startScan(mode: "scan" | "rescan") {
    if (pendingRef.current || isRunning) return;
    pendingRef.current = true;
    setOperationMode(mode);
    setOperationStartedAt(Date.now());
    setPending(true);
    try {
      const response = await fetch("/api/app/gmail-scan/start", { method: "POST" });
      const payload = (await response.json()) as { progress?: ScanProgress; error?: string };
      if (!response.ok) throw new Error("We couldn't scan your inbox. Try again.");
      setProgress(payload.progress ?? null);
      setOperationStartedAt(payload.progress?.startedAt ?? Date.now());
    } catch (error) {
      setProgress({
        scanId: "scan-error",
        provider: "gmail",
        status: "failed",
        processed: 0,
        startedAt: Date.now(),
        errors: [error instanceof Error ? error.message : "We couldn't scan your inbox. Try again."]
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-busy={working} className="panel mt-6 p-6">
      <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">
        {isRunning ? "Scanning your inbox..." : progress?.status === "completed" ? "Your Inbox Report is ready." : "Ready to scan your inbox"}
      </h2>
      <p className="muted">
        We&apos;ll use basic email details to find recurring senders, old mail, and likely clutter. Subject lines are processed temporarily only to protect messages that may be important. We don&apos;t read email bodies or download attachments.
      </p>

      {working ? (
        <OperationStatus
          description="We're safely checking your mailbox and building your Inbox Report. For large inboxes this can take a few minutes."
          startedAt={progress?.startedAt ?? operationStartedAt}
          title={operationMode === "rescan" ? "Rescanning your inbox..." : "Scanning your inbox..."}
        />
      ) : null}

      <div className="mt-5 h-3 overflow-hidden rounded-full bg-[var(--soft)]">
        <div className="h-full bg-[var(--teal)] transition-all" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Metric label="Processed" value={progress?.processed.toLocaleString() ?? "0"} />
        <Metric label="Mailbox messages" value={progress?.mailboxExists?.toLocaleString() ?? "-"} />
      </div>

      {progress?.errors.length ? <p className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{progress.errors[0]}</p> : null}

      <div className="mt-6 flex flex-wrap gap-3">
        {progress?.status === "completed" ? (
          <Link className="btn btn-primary focus-ring" href="/app/report">
            View Inbox Report
          </Link>
        ) : (
          <button className="btn btn-primary focus-ring" disabled={working} onClick={() => startScan("scan")} type="button">
            {working ? "Scanning..." : "Scan my inbox"}
          </button>
        )}
        {progress?.status === "completed" ? (
          <button className="btn btn-secondary focus-ring" disabled={working} onClick={() => startScan("rescan")} type="button">
            {pending && operationMode === "rescan" ? "Rescanning..." : "Rescan inbox"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--line)] p-4">
      <p className="muted m-0 text-sm">{label}</p>
      <p className="m-0 mt-2 text-xl font-extrabold text-[var(--navy)]">{value}</p>
    </div>
  );
}
