"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { OperationStatus } from "@/components/product/OperationStatus";

type BenchmarkLimit = 5000 | 10000 | 25000 | 50000 | 100000 | "full";
type BenchmarkProgress = {
  scanId: string;
  provider: "gmail";
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  limit: BenchmarkLimit;
  batchSize: number;
  processed: number;
  mailboxExists?: number;
  startedAt: number;
  completedAt?: number;
  connectionMs?: number;
  conversationIndexMs?: number;
  metadataMs?: number;
  subjectProtectionMs?: number;
  protectionClassificationMs?: number;
  aggregationMs?: number;
  durationMs?: number;
  messagesPerSecond?: number;
  messagesPerMinute?: number;
  approxMemoryMb?: number;
  peakParticipatedConversationCount?: number;
  errors: string[];
  notes: string[];
};

const limits: BenchmarkLimit[] = [5000, 10000, 25000, 50000, 100000, "full"];

export function GmailBenchmarkClient({ initialProgress }: { initialProgress: BenchmarkProgress | null }) {
  const router = useRouter();
  const [limit, setLimit] = useState<BenchmarkLimit>(10000);
  const [batchSize, setBatchSize] = useState(1000);
  const [progress, setProgress] = useState<BenchmarkProgress | null>(initialProgress);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const isRunning = progress?.status === "running";
  const percent = useMemo(() => {
    if (!progress?.mailboxExists) return 0;
    const target = progress.limit === "full" ? progress.mailboxExists : Math.min(progress.limit, progress.mailboxExists);
    return target > 0 ? Math.min(100, Math.round((progress.processed / target) * 100)) : 0;
  }, [progress]);

  useEffect(() => {
    if (!isRunning) return;
    const interval = window.setInterval(async () => {
      const response = await fetch("/api/dev/gmail-benchmark/status", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { progress: BenchmarkProgress | null };
      setProgress(payload.progress);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isRunning]);

  async function start() {
    if (pendingRef.current || isRunning) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const response = await fetch("/api/dev/gmail-benchmark/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit, batchSize })
      });
      const payload = (await response.json()) as { progress?: BenchmarkProgress; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Benchmark could not start.");
      setProgress(payload.progress ?? null);
    } catch (error) {
      setProgress({
        scanId: "local-error",
        provider: "gmail",
        status: "failed",
        limit,
        batchSize,
        processed: 0,
        startedAt: Date.now(),
        errors: [error instanceof Error ? error.message : "Benchmark could not start."],
        notes: []
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function cancel() {
    await fetch("/api/dev/gmail-benchmark/cancel", { method: "POST" });
    const response = await fetch("/api/dev/gmail-benchmark/status", { cache: "no-store" });
    const payload = (await response.json()) as { progress: BenchmarkProgress | null };
    setProgress(payload.progress);
  }

  async function disconnect() {
    setPending(true);
    await fetch("/api/app/disconnect", { method: "POST" });
    router.push("/");
  }

  return (
    <section aria-busy={pending || isRunning} className="grid gap-6 lg:grid-cols-[0.45fr_0.55fr]">
      <div className="panel p-6">
        <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Run benchmark</h2>
        <div className="mt-5 grid gap-4">
          <label className="grid gap-2 text-sm font-bold text-[var(--navy)]">
            Scan limit
            <select
              className="rounded-md border border-[var(--line)] bg-white px-3 py-2"
              disabled={pending || isRunning}
              value={String(limit)}
              onChange={(event) => setLimit(event.target.value === "full" ? "full" : (Number(event.target.value) as BenchmarkLimit))}
            >
              {limits.map((value) => (
                <option key={value} value={value}>
                  {value === "full" ? "Full mailbox" : value.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-bold text-[var(--navy)]">
            Batch size
            <input
              className="rounded-md border border-[var(--line)] px-3 py-2"
              disabled={pending || isRunning}
              max={5000}
              min={100}
              step={100}
              type="number"
              value={batchSize}
              onChange={(event) => setBatchSize(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <button className="btn btn-primary focus-ring" disabled={pending || isRunning} onClick={start} type="button">
            {pending || isRunning ? "Running..." : "Start"}
          </button>
          <button className="btn btn-secondary focus-ring" disabled={!isRunning} onClick={cancel} type="button">
            Cancel
          </button>
          <button className="btn btn-secondary focus-ring" disabled={pending || isRunning} onClick={disconnect} type="button">
            Disconnect
          </button>
        </div>
      </div>

      <div className="panel p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Progress</h2>
          <span className="badge">{progress?.status ?? "idle"}</span>
        </div>
        {pending || isRunning ? (
          <OperationStatus
            description="We're reading mailbox metadata and measuring the scan path."
            startedAt={progress?.startedAt}
            title="Running safety benchmark..."
          />
        ) : null}
        <div className="mt-5 h-3 overflow-hidden rounded-full bg-[var(--soft)]">
          <div className="h-full bg-[var(--teal)] transition-all" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Metric label="Processed" value={progress?.processed.toLocaleString() ?? "0"} />
          <Metric label="Mailbox messages" value={progress?.mailboxExists?.toLocaleString() ?? "-"} />
          <Metric label="Messages/sec" value={progress?.messagesPerSecond?.toLocaleString() ?? "-"} />
          <Metric label="Duration" value={formatMs(progress?.durationMs)} />
          <Metric label="Connection" value={formatMs(progress?.connectionMs)} />
          <Metric label="Sent conversation index" value={formatMs(progress?.conversationIndexMs)} />
          <Metric label="Metadata" value={formatMs(progress?.metadataMs)} />
          <Metric label="Subject protection" value={formatMs(progress?.subjectProtectionMs)} />
          <Metric label="Protection rules" value={formatMs(progress?.protectionClassificationMs)} />
          <Metric label="Aggregation" value={formatMs(progress?.aggregationMs)} />
          <Metric label="Participation set" value={progress?.peakParticipatedConversationCount?.toLocaleString() ?? "-"} />
          <Metric label="Memory RSS" value={progress?.approxMemoryMb ? `${progress.approxMemoryMb} MB` : "-"} />
        </div>
        {progress?.errors.length ? <p className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{progress.errors[0]}</p> : null}
        {progress?.status === "completed" ? (
          <Link className="btn btn-primary focus-ring mt-5" href="/app/report">
            View transient report
          </Link>
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

function formatMs(value?: number) {
  if (value === undefined) return "-";
  if (value < 1000) return `${value} ms`;
  return `${Math.round((value / 1000) * 10) / 10}s`;
}
