"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { OperationStatus } from "@/components/product/OperationStatus";
import { startAdaptivePolling } from "@/lib/adaptive-polling";

type ScanProgress = {
  phase?: "preparing" | "sent_conversations" | "messages";
  scanId: string;
  provider: "gmail" | "microsoft";
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  processed: number;
  mailboxExists?: number;
  startedAt: number;
  errors: string[];
  outlookTransport?: "graph" | "imap";
};

export function GmailScanClient({ initialProgress }: { initialProgress: ScanProgress | null }) {
  return <MailboxScanClient initialProgress={initialProgress} provider="gmail" />;
}

export function OutlookScanClient({
  initialProgress,
  imapAvailable,
  imapBenchmarkEnabled
}: {
  initialProgress: ScanProgress | null;
  imapAvailable: boolean;
  imapBenchmarkEnabled: boolean;
}) {
  return (
    <MailboxScanClient
      imapAvailable={imapAvailable}
      imapBenchmarkEnabled={imapBenchmarkEnabled}
      initialProgress={initialProgress}
      provider="microsoft"
    />
  );
}

function MailboxScanClient({
  initialProgress,
  provider,
  imapAvailable = false,
  imapBenchmarkEnabled = false
}: {
  initialProgress: ScanProgress | null;
  provider: "gmail" | "microsoft";
  imapAvailable?: boolean;
  imapBenchmarkEnabled?: boolean;
}) {
  const [progress, setProgress] = useState<ScanProgress | null>(initialProgress);
  const [pending, setPending] = useState(false);
  const [reattached, setReattached] = useState(initialProgress?.status === "running");
  const [pollError, setPollError] = useState(false);
  const [operationMode, setOperationMode] = useState<"scan" | "rescan">("scan");
  const [operationStartedAt, setOperationStartedAt] = useState<number | undefined>(initialProgress?.startedAt);
  const pendingRef = useRef(false);
  const outlook = provider === "microsoft";
  const [outlookTransport, setOutlookTransport] = useState<"graph" | "imap">(
    initialProgress?.outlookTransport ?? "graph"
  );
  const endpoint = outlook ? "/api/app/microsoft-scan" : "/api/app/gmail-scan";

  const isRunning = progress?.status === "running";
  const working = pending || isRunning;
  const percent = useMemo(() => {
    if (!progress?.mailboxExists) return 0;
    return Math.min(100, Math.round((progress.processed / progress.mailboxExists) * 100));
  }, [progress]);

  useEffect(() => {
    if (!isRunning) return;
    return startAdaptivePolling(async (signal) => {
      const response = await fetch(`${endpoint}/status`, { cache: "no-store", signal });
      if (!response.ok) throw new Error("Status unavailable");
      const payload = (await response.json()) as { progress: ScanProgress | null };
      if (signal.aborted) return false;
      setPollError(false);
      setProgress(payload.progress);
      return payload.progress?.status === "running";
    }, () => setPollError(true));
  }, [endpoint, isRunning, progress?.scanId]);

  async function startScan(mode: "scan" | "rescan") {
    if (pendingRef.current || isRunning) return;
    pendingRef.current = true;
    setReattached(false);
    setOperationMode(mode);
    setOperationStartedAt(Date.now());
    setProgress(null);
    setPending(true);
    try {
      const response = await fetch(`${endpoint}/start`, {
        method: "POST",
        headers: outlook ? { "Content-Type": "application/json" } : undefined,
        body: outlook ? JSON.stringify({ transport: outlookTransport }) : undefined
      });
      const payload = (await response.json()) as { progress?: ScanProgress; error?: string; reused?: boolean };
      if (!response.ok) throw new Error("We couldn't scan your inbox. Try again.");
      setProgress(payload.progress ?? null);
      setReattached(payload.reused === true);
      setOperationStartedAt(payload.progress?.startedAt ?? Date.now());
    } catch (error) {
      setProgress({
        scanId: "scan-error",
        provider,
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
    <section aria-busy={working} className="mt-6 border-t border-[var(--line)] py-6">
      {pollError ? <p role="alert">Status could not be refreshed. Retrying...</p> : null}
      <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">
        {isRunning
          ? outlook ? "Scanning Outlook inbox..." : "Scanning your inbox..."
          : progress?.status === "completed"
            ? "Your Inbox Report is ready."
            : outlook ? "Ready to scan Outlook" : "Ready to scan your inbox"}
      </h2>
      <p className="muted">
        We&apos;ll use basic email details to find recurring senders, old mail, and likely clutter. Subject lines are processed temporarily only to protect messages that may be important. We don&apos;t read email bodies or download attachments.
      </p>

      {outlook && imapBenchmarkEnabled ? (
        <div className="mt-5">
          <div aria-label="Outlook scan transport" className="inline-flex rounded-md border border-[var(--line)] p-1" role="group">
            <button
              aria-pressed={outlookTransport === "graph"}
              className={`focus-ring rounded px-3 py-2 text-sm font-bold ${outlookTransport === "graph" ? "bg-[var(--navy)] text-white" : "text-[var(--navy)]"}`}
              disabled={working}
              onClick={() => setOutlookTransport("graph")}
              type="button"
            >
              Graph
            </button>
            <button
              aria-pressed={outlookTransport === "imap"}
              className={`focus-ring rounded px-3 py-2 text-sm font-bold ${outlookTransport === "imap" ? "bg-[var(--navy)] text-white" : "text-[var(--navy)]"}`}
              disabled={working || !imapAvailable}
              onClick={() => setOutlookTransport("imap")}
              type="button"
            >
              IMAP benchmark
            </button>
          </div>
          {!imapAvailable ? (
            <form action="/api/oauth/microsoft/imap/start" className="mt-3" method="get">
              <button className="btn btn-secondary focus-ring" disabled={working} type="submit">
                Approve Outlook IMAP access
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {working && outlook && reattached ? (
        <p role="status" className="muted mt-4 text-sm">Continuing your existing scan. Elapsed time includes work already in progress.</p>
      ) : null}
      {working ? (
        <OperationStatus
          description={outlook && (progress?.phase === "preparing" || progress?.phase === "sent_conversations") ? "Safety checks run before the message count increases. Large inboxes can take several minutes." : "We're safely checking your mailbox and building your Inbox Report. For large inboxes this can take a few minutes."}
          startedAt={progress?.startedAt ?? operationStartedAt}
          title={outlook && progress?.phase === "preparing" ? "Preparing your inbox..." : outlook && progress?.phase === "sent_conversations" ? "Checking sent conversations..." : operationMode === "rescan" ? "Rescanning your inbox..." : outlook ? "Scanning Outlook inbox..." : "Scanning your inbox..."}
        />
      ) : null}

      {!outlook ? (
        <div role="progressbar" aria-label="Inbox scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-5 h-2 overflow-hidden rounded-full bg-[var(--line)]">
          <div className="h-full bg-[var(--teal)] transition-all" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <div className={`mt-5 grid gap-3 ${outlook ? "" : "sm:grid-cols-2"}`}>
        <Metric label={outlook ? "Messages checked" : "Processed"} value={progress?.processed.toLocaleString() ?? "0"} />
        {!outlook ? <Metric label="Mailbox messages" value={progress?.mailboxExists?.toLocaleString() ?? "-"} /> : null}
      </div>

      {progress?.errors.length ? <p className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{progress.errors[0]}</p> : null}

      <div className="mt-6 flex flex-wrap gap-3">
        {progress?.status === "completed" ? (
          <Link className="btn btn-primary focus-ring" href="/app/report">
            View Inbox Report
          </Link>
        ) : (
          <button className="btn btn-primary focus-ring" disabled={working} onClick={() => startScan("scan")} type="button">
            {working ? "Scanning..." : outlook ? "Scan Outlook inbox" : "Scan my inbox"}
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
