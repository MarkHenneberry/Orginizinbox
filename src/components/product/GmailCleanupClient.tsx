"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContextBackAction } from "@/components/product/ContextBackAction";
import { OperationStatus } from "@/components/product/OperationStatus";
import {
  createDefaultCleanupSelection,
  eligibleCleanupGroupIndices,
  filterAndSortCleanupGroups,
  updateCleanupSelection,
  type CleanupSortKey
} from "@/lib/domain/cleanup-sender-workspace";
import { formatDevelopmentCleanupSummary, type GmailCleanupJobView } from "@/lib/domain/gmail-cleanup-summary";
import type { CleanupSenderGroup } from "@/lib/providers/gmail/cleanup-candidates";

type ActiveCleanupOperation = "resolution" | "benchmark" | "trash" | "undo" | "rescan" | "start_over";

export function GmailCleanupClient({
  groups,
  cleanupEnabled,
  fixtureMode,
  countOptions,
  reportStale,
  developmentMode
}: {
  groups: CleanupSenderGroup[];
  cleanupEnabled: boolean;
  fixtureMode: boolean;
  countOptions: number[];
  reportStale: boolean;
  developmentMode: boolean;
}) {
  const router = useRouter();
  const [selectedGroupIndices, setSelectedGroupIndices] = useState<Set<number>>(
    () => createDefaultCleanupSelection(groups)
  );
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<CleanupSortKey>("ready");
  const [requestedCount, setRequestedCount] = useState(countOptions.at(-1) ?? 0);
  const [job, setJob] = useState<GmailCleanupJobView | null>(null);
  const [checkedGroupIndices, setCheckedGroupIndices] = useState<number[]>([]);
  const [reviewStarted, setReviewStarted] = useState(false);
  const [snapshotExpired, setSnapshotExpired] = useState(false);
  const [finalStep, setFinalStep] = useState(false);
  const [activeOperation, setActiveOperation] = useState<ActiveCleanupOperation | null>(null);
  const [operationStartedAt, setOperationStartedAt] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const activeOperationRef = useRef<ActiveCleanupOperation | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);

  const busy = activeOperation !== null;
  const activeJobId = job?.id;

  const visibleGroups = useMemo(() => filterAndSortCleanupGroups(groups, search, sortKey), [groups, search, sortKey]);
  const selectedGroups = groups.filter((group) => selectedGroupIndices.has(group.index));
  const selectedReadyCount = selectedGroups.reduce((total, group) => total + group.cleanupCandidateCount, 0);
  const selectedReviewCount = selectedGroups.reduce((total, group) => total + group.reviewMessages, 0);
  const selectedProtectedCount = selectedGroups.reduce((total, group) => total + group.protectedMessages, 0);
  const checkedGroupIndexSet = useMemo(() => new Set(checkedGroupIndices), [checkedGroupIndices]);
  const checkedGroups = groups.filter((group) => checkedGroupIndexSet.has(group.index));
  const mutationOrVerificationActive =
    activeOperation === "trash" ||
    activeOperation === "undo" ||
    job?.status === "running" ||
    job?.status === "undoing";
  const cleanupComplete = Boolean(
    job && (
      job.status === "completed" ||
      job.status === "partial" ||
      job.status === "undone" ||
      job.status === "undo_partial" ||
      job.status === "undo_failed" ||
      (job.status === "failed" && job.mutationStarted)
    )
  );
  const showFrozenReviewContext = reviewStarted && Boolean(job) && !mutationOrVerificationActive && !cleanupComplete;
  const eligibleIndices = eligibleCleanupGroupIndices(groups);
  const visibleEligibleIndices = visibleGroups.filter((group) => group.eligible).map((group) => group.index);
  const allVisibleEligibleSelected =
    visibleEligibleIndices.length > 0 && visibleEligibleIndices.every((index) => selectedGroupIndices.has(index));
  const disabled =
    !cleanupEnabled ||
    fixtureMode ||
    reportStale ||
    selectedGroupIndices.size === 0 ||
    requestedCount > selectedReadyCount ||
    busy;

  function resetPreview() {
    setJob(null);
    setCheckedGroupIndices([]);
    setReviewStarted(false);
    setSnapshotExpired(false);
    setFinalStep(false);
    setError(null);
  }

  function toggleGroup(group: CleanupSenderGroup) {
    if (!group.eligible || busy) return;
    setSelectedGroupIndices((current) => {
      const next = new Set(current);
      if (next.has(group.index)) next.delete(group.index);
      else next.add(group.index);
      return next;
    });
    resetPreview();
  }

  function toggleVisibleEligible() {
    if (busy) return;
    setSelectedGroupIndices((current) =>
      updateCleanupSelection(current, visibleEligibleIndices, !allVisibleEligibleSelected)
    );
    resetPreview();
  }

  function selectAllEligible() {
    if (busy) return;
    setSelectedGroupIndices(new Set(eligibleIndices));
    resetPreview();
  }

  function clearSelection() {
    if (busy) return;
    setSelectedGroupIndices(new Set());
    resetPreview();
  }

  function beginOperation(operation: ActiveCleanupOperation) {
    if (activeOperationRef.current) return false;
    activeOperationRef.current = operation;
    setActiveOperation(operation);
    setOperationStartedAt(Date.now());
    return true;
  }

  function finishOperation(operation: ActiveCleanupOperation) {
    if (activeOperationRef.current !== operation) return;
    activeOperationRef.current = null;
    setActiveOperation(null);
  }

  useEffect(() => {
    if (!activeJobId || (activeOperation !== "trash" && activeOperation !== "undo")) return;
    let cancelled = false;
    const poll = async () => {
      const response = await fetch("/api/dev/gmail-cleanup/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: activeJobId })
      });
      if (!response.ok || cancelled || !activeOperationRef.current) return;
      const body = (await response.json()) as { job?: GmailCleanupJobView };
      if (body.job) setJob(body.job);
    };
    void poll();
    const interval = window.setInterval(poll, 500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeOperation, activeJobId]);

  useEffect(() => {
    if (!reviewStarted) return;
    reviewHeadingRef.current?.focus();
  }, [reviewStarted]);

  useEffect(() => {
    if (
      !reviewStarted ||
      job?.status !== "ready" ||
      !job.confirmationExpiresAt ||
      activeOperation === "trash"
    ) return;
    const remainingMs = job.confirmationExpiresAt - Date.now();
    const timeout = window.setTimeout(() => {
      setSnapshotExpired(true);
      setFinalStep(false);
    }, Math.max(remainingMs, 0));
    return () => window.clearTimeout(timeout);
  }, [activeOperation, job?.confirmationExpiresAt, job?.status, reviewStarted]);

  async function resolvePreview(benchmarkOnly = false) {
    const operation = benchmarkOnly ? "benchmark" : "resolution";
    if (!beginOperation(operation)) return;
    const groupIndices = [...selectedGroupIndices];
    setError(null);
    setFinalStep(false);
    try {
      const response = await fetch("/api/dev/gmail-cleanup/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupIndices, requestedCount, benchmarkOnly })
      });
      const body = (await response.json()) as { job?: GmailCleanupJobView; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? "We couldn't check these messages. Try again.");
      setJob(body.job);
      setSnapshotExpired(false);
      if (!benchmarkOnly && body.job.status === "ready") {
        setCheckedGroupIndices(groupIndices);
        setReviewStarted(true);
      }
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "We couldn't check these messages. Try again.");
    } finally {
      finishOperation(operation);
    }
  }

  async function confirmCleanup() {
    if (!job || !beginOperation("trash")) return;
    setError(null);
    try {
      const response = await fetch("/api/dev/gmail-cleanup/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, confirmation: "MOVE_TO_TRASH" })
      });
      const body = (await response.json()) as { job?: GmailCleanupJobView; error?: string };
      if (response.status === 410) {
        setSnapshotExpired(true);
        setFinalStep(false);
        return;
      }
      if (!response.ok || !body.job) throw new Error(body.error ?? "We couldn't move these messages to Trash. Try again.");
      setJob(body.job);
      setSnapshotExpired(false);
      setFinalStep(false);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "We couldn't move these messages to Trash. Try again.");
    } finally {
      finishOperation("trash");
    }
  }

  async function startOver() {
    if (!job || !beginOperation("start_over")) return;
    setError(null);
    try {
      const response = await fetch("/api/dev/gmail-cleanup/start-over", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id })
      });
      const body = (await response.json()) as { discarded?: boolean; error?: string };
      if (!response.ok || !body.discarded) {
        throw new Error(body.error ?? "We couldn't start over. Try again.");
      }
      resetPreview();
    } catch (startOverError) {
      setError(startOverError instanceof Error ? startOverError.message : "We couldn't start over. Try again.");
    } finally {
      finishOperation("start_over");
    }
  }

  async function undoCleanup() {
    if (!job || !beginOperation("undo")) return;
    setError(null);
    try {
      const response = await fetch("/api/dev/gmail-cleanup/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id })
      });
      const body = (await response.json()) as { job?: GmailCleanupJobView; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? "We couldn't restore these messages. Try again.");
      setJob(body.job);
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : "We couldn't restore these messages. Try again.");
    } finally {
      finishOperation("undo");
    }
  }

  async function rescanInbox() {
    if (!beginOperation("rescan")) return;
    setError(null);
    let navigating = false;
    try {
      const response = await fetch("/api/app/gmail-scan/start", { method: "POST" });
      if (!response.ok) throw new Error("We couldn't rescan your inbox. Try again.");
      navigating = true;
      router.push("/app/scan");
    } catch (rescanError) {
      setError(rescanError instanceof Error ? rescanError.message : "We couldn't rescan your inbox. Try again.");
    } finally {
      if (!navigating) finishOperation("rescan");
    }
  }

  return (
    <section
      aria-busy={busy}
      className={showFrozenReviewContext || !reviewStarted
        ? "mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]"
        : "mt-6 max-w-2xl"}
    >
      {!reviewStarted ? <div className="panel overflow-hidden">
        <div className="border-b border-[var(--line)] p-5">
          <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Select sender groups</h2>
          <div aria-live="polite" className="mt-4 border-l-4 border-[var(--blue)] bg-sky-50 px-4 py-3">
            <strong className="block text-lg text-[var(--navy)]">
              {selectedGroupIndices.size.toLocaleString()} eligible senders selected
            </strong>
            <span className="muted block text-sm">{selectedReadyCount.toLocaleString()} Suggested emails</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_190px]">
            <label className="grid gap-1 text-xs font-bold text-[var(--navy)]" htmlFor="cleanup-search">Search
              <input
                className="focus-ring min-w-0 rounded-md border border-[var(--line)] bg-white px-3 py-2 text-base font-normal"
                id="cleanup-search"
                disabled={busy}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search senders"
                type="search"
                value={search}
              />
            </label>
            <label className="grid gap-1 text-xs font-bold text-[var(--navy)]" htmlFor="cleanup-sort">Sort
              <select
                className="focus-ring rounded-md border border-[var(--line)] bg-white px-3 py-2 text-base font-normal"
                id="cleanup-sort"
                disabled={busy}
                onChange={(event) => setSortKey(event.target.value as CleanupSortKey)}
                value={sortKey}
              >
                <option value="ready">Most suggested</option>
                <option value="emails">Most emails</option>
                <option value="unread">Most unread</option>
                <option value="oldest">Oldest</option>
                <option value="storage">Most storage</option>
                <option value="recommendation">Recommendation</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
            {selectedGroupIndices.size > 0 ? (
              <button className="focus-ring font-bold text-[var(--blue)] underline underline-offset-4" disabled={busy} onClick={clearSelection} type="button">
                Clear selection
              </button>
            ) : null}
            {selectedGroupIndices.size < eligibleIndices.length ? (
              <button className="focus-ring font-bold text-[var(--blue)] underline underline-offset-4" disabled={busy} onClick={selectAllEligible} type="button">
                Select all eligible
              </button>
            ) : null}
            {search.trim() ? (
              <button
                className="focus-ring font-bold text-[var(--blue)] underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={visibleEligibleIndices.length === 0 || busy}
                onClick={toggleVisibleEligible}
                type="button"
              >
                {allVisibleEligibleSelected ? "Clear eligible results" : "Select all eligible results"}
              </button>
            ) : null}
          </div>
        </div>

        <div aria-label="Sender groups" className="focus-ring lg:max-h-[calc(100vh-18rem)] lg:min-h-[360px] lg:overflow-y-auto" tabIndex={0}>
          <div className="hidden grid-cols-[minmax(180px,1fr)_minmax(150px,190px)_repeat(4,70px)] gap-3 border-b border-[var(--line)] bg-[var(--surface-subtle)] px-5 py-2 text-xs font-bold text-[var(--navy)] md:grid">
            <span>Sender</span><span>Recommendation</span><span className="text-right">Total</span><span className="text-right">Suggested</span><span className="text-right">Review</span><span className="text-right">Protected</span>
          </div>
          {visibleGroups.length ? (
            visibleGroups.map((group) => (
              <label
                className={`grid gap-3 border-b border-[var(--line)] px-5 py-4 last:border-b-0 md:grid-cols-[minmax(180px,1fr)_minmax(150px,190px)_repeat(4,70px)] md:items-center ${
                  group.eligible ? "cursor-pointer hover:bg-sky-50/50" : "cursor-not-allowed bg-neutral-50 text-neutral-500"
                }`}
                key={group.index}
              >
                <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3">
                  <input
                    aria-label={`Select ${group.displayName}`}
                    checked={selectedGroupIndices.has(group.index)}
                    className="mt-1"
                    disabled={!group.eligible || busy}
                    onChange={() => toggleGroup(group)}
                    type="checkbox"
                  />
                  <span className="min-w-0">
                    <strong className="block truncate text-[var(--navy)]">{group.displayName}</strong>
                    <span className="muted block truncate text-xs">{group.secondaryLabel}</span>
                    {!group.eligible ? <span className="block text-xs font-bold">{ineligibleLabel(group)}</span> : null}
                  </span>
                </span>
                <span>
                  <span className={`inline-flex border px-2 py-1 text-xs font-extrabold ${recommendationBadgeClass(group)}`}>
                    {recommendationLabel(group)}
                  </span>
                  {!group.eligible ? <span className="mt-1 block text-xs">{ineligibleExplanation(group)}</span> : null}
                </span>
                <Metric label="Total" value={group.totalMessages} />
                <Metric label="Suggested" value={group.cleanupCandidateCount} strong={group.eligible} />
                <Metric label="Review" value={group.reviewMessages} />
                <Metric label="Protected" value={group.protectedMessages} />
              </label>
            ))
          ) : (
            <p className="muted m-0 p-5">No sender groups match this search.</p>
          )}
        </div>
      </div> : null}

      <aside className={`panel p-5 ${showFrozenReviewContext ? "order-1 lg:order-2 lg:sticky lg:top-24" : reviewStarted ? "" : "lg:sticky lg:top-24"}`}>
        {!reviewStarted ? (
          <>
            <h2 className="m-0 text-2xl font-extrabold text-[var(--navy)]">Check messages</h2>
            <dl className="mt-4 grid gap-2 text-sm">
              <Row label="Selected senders" value={selectedGroupIndices.size.toLocaleString()} />
              <Row label="Suggested for cleanup" value={selectedReadyCount.toLocaleString()} />
              <Row label="Review excluded" value={selectedReviewCount.toLocaleString()} />
              <Row label="Protected excluded" value={selectedProtectedCount.toLocaleString()} />
            </dl>

            <label className="mt-5 block text-sm font-bold text-[var(--navy)]" htmlFor="cleanup-count">Messages to check</label>
            <select
              className="focus-ring mt-2 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2"
              disabled={!cleanupEnabled || fixtureMode || reportStale || busy}
              id="cleanup-count"
              onChange={(event) => {
                setRequestedCount(Number(event.target.value));
                resetPreview();
              }}
              value={requestedCount}
            >
              {countOptions.map((count) => <option key={count} value={count}>{count} messages</option>)}
            </select>

            {requestedCount > selectedReadyCount ? <Notice text="Select enough eligible senders to reach this suggested total." /> : null}
            {!cleanupEnabled ? <Notice text="Cleanup is not available right now." /> : null}
            {fixtureMode ? <Notice text="Connect Gmail and run a scan before cleanup." /> : null}
            {reportStale ? <Notice text="Your inbox has changed. Rescan before cleaning more email." /> : null}
            {error ? <Notice text={error} /> : null}

            <button className="btn btn-primary focus-ring mt-5 w-full" disabled={disabled} onClick={() => resolvePreview(false)} type="button">
              {activeOperation === "resolution" ? "Checking messages..." : `Check ${requestedCount.toLocaleString()} messages`}
            </button>
            {developmentMode && requestedCount === 100 ? (
              <button className="btn btn-secondary focus-ring mt-2 w-full" disabled={disabled} onClick={() => resolvePreview(true)} type="button">
                {activeOperation === "benchmark" ? "Running safety benchmark..." : "Run safety benchmark"}
              </button>
            ) : null}

            {activeOperation ? (
              <CleanupOperationStatus
                job={job}
                operation={activeOperation}
                requestedCount={requestedCount}
                startedAt={operationStartedAt}
              />
            ) : null}

            {job ? (
              <div className="mt-5 border-t border-[var(--line)] pt-4">
                <p className="m-0 font-extrabold text-[var(--navy)]">{job.groupDisplayName}</p>
                <PreviewAccounting job={job} />
                <SenderGroupFailureNotice job={job} />
                {job.status === "benchmark_complete" ? <Notice text="Safety benchmark complete. Nothing was moved." /> : null}
                {job.status === "insufficient" ? (
                  <Notice text={`Only ${job.resolvedCount.toLocaleString()} messages remain safe. Nothing was moved. Change the selection or choose a lower count.`} />
                ) : null}
                {job.status === "failed" && !job.mutationStarted ? <Notice text={job.error ?? "The safety check could not be completed. Nothing was moved."} /> : null}
                {developmentMode ? <DevelopmentCleanupDetails job={job} /> : null}
              </div>
            ) : null}
          </>
        ) : job ? (
          <div aria-live="polite">
            <h2
              className="focus-ring m-0 text-2xl font-extrabold text-[var(--navy)]"
              ref={reviewHeadingRef}
              tabIndex={-1}
            >
              {snapshotExpired
                ? "This cleanup check has expired."
                : job.status === "completed" || job.status === "undone"
                  ? "Cleanup complete"
                  : "Suggested cleanup"}
            </h2>

            {activeOperation ? (
              <CleanupOperationStatus
                job={job}
                operation={activeOperation}
                requestedCount={requestedCount}
                startedAt={operationStartedAt}
              />
            ) : null}
            {error ? <Notice text={error} /> : null}

            {snapshotExpired ? (
              <div className="mt-4">
                <p className="muted m-0 text-sm">For safety, check your selection again before moving messages.</p>
                <button className="btn btn-secondary focus-ring mt-4 w-full" disabled={busy} onClick={startOver} type="button">
                  {activeOperation === "start_over" ? "Starting over..." : "Start over"}
                </button>
              </div>
            ) : job.status === "ready" ? (
              <>
                <dl className="mt-4 grid gap-2 text-sm">
                  <Row label="Messages rechecked" value={job.resolvedCount.toLocaleString()} />
                  <Row label="Sender groups contributing" value={job.contributingSenderGroupCount.toLocaleString()} />
                  <Row label="Excluded during the final safety check" value={job.excludedMessageCount.toLocaleString()} />
                </dl>
                <p className="muted m-0 mt-4 text-sm">Protected and Review messages were left alone.</p>
                <p className="muted m-0 mt-2 text-sm">Nothing will be permanently deleted.</p>
                <SenderGroupFailureNotice job={job} />

                {!busy && !finalStep ? (
                  <div className="mt-5 grid gap-2">
                    <button className="btn btn-primary focus-ring w-full" onClick={() => setFinalStep(true)} type="button">
                      Move {job.resolvedCount.toLocaleString()} to Trash
                    </button>
                    <button className="btn btn-secondary focus-ring w-full" onClick={startOver} type="button">Start over</button>
                  </div>
                ) : null}
                {!busy && finalStep ? (
                  <div className="mt-5 grid gap-2 border-t border-[var(--line)] pt-4">
                    <p className="m-0 font-extrabold text-[var(--navy)]">Move {job.resolvedCount.toLocaleString()} messages to Trash?</p>
                    <p className="muted m-0 text-sm">We rechecked these messages and left protected email out.</p>
                    <p className="muted m-0 text-sm">Nothing will be permanently deleted.</p>
                    <button className="btn btn-secondary focus-ring w-full" onClick={() => setFinalStep(false)} type="button">Cancel</button>
                    <button className="btn btn-primary focus-ring w-full" onClick={confirmCleanup} type="button">Move {job.resolvedCount.toLocaleString()} to Trash</button>
                  </div>
                ) : null}
              </>
            ) : job.status === "completed" ? (
              <CompletedResult busy={busy} job={job} onRescan={rescanInbox} onUndo={undoCleanup} />
            ) : job.status === "partial" || (job.status === "failed" && job.mutationStarted) ? (
              <PartialResult busy={busy} job={job} onRescan={rescanInbox} />
            ) : job.status === "undone" || job.status === "undo_partial" || job.status === "undo_failed" ? (
              <UndoResult busy={busy} job={job} onRescan={rescanInbox} />
            ) : job.status !== "running" && job.status !== "undoing" ? (
              <div className="mt-4">
                <Notice text={job.error ?? "This cleanup check can no longer be used. Nothing was moved."} />
                <button className="btn btn-secondary focus-ring mt-4 w-full" disabled={busy} onClick={startOver} type="button">Start over</button>
              </div>
            ) : null}

            {developmentMode ? <DevelopmentCleanupDetails job={job} /> : null}
          </div>
        ) : null}
      </aside>
      {showFrozenReviewContext && job ? (
        <FrozenSenderContext groups={checkedGroups} job={job} />
      ) : null}
    </section>
  );
}

function FrozenSenderContext({ groups, job }: { groups: CleanupSenderGroup[]; job: GmailCleanupJobView }) {
  return (
    <section aria-label="Frozen sender context" className="order-2 lg:order-1">
      <div className="panel hidden overflow-hidden lg:block">
        <FrozenSenderSummary job={job} />
        <div className="grid grid-cols-[minmax(180px,1fr)_minmax(150px,190px)_repeat(3,70px)] gap-3 border-b border-[var(--line)] bg-[var(--surface-subtle)] px-5 py-2 text-xs font-bold text-[var(--navy)]">
          <span>Sender</span>
          <span>Recommendation</span>
          <span className="text-right">Suggested</span>
          <span className="text-right">Review</span>
          <span className="text-right">Protected</span>
        </div>
        <FrozenSenderRows groups={groups} bounded />
      </div>

      <details className="panel overflow-hidden lg:hidden">
        <summary className="focus-ring cursor-pointer px-5 py-4 font-extrabold text-[var(--navy)]">
          Checked sender groups
          <span className="muted ml-2 text-sm font-normal">{groups.length.toLocaleString()}</span>
        </summary>
        <FrozenSenderSummary job={job} compact />
        <FrozenSenderRows groups={groups} />
      </details>
    </section>
  );
}

function FrozenSenderSummary({ job, compact = false }: { job: GmailCleanupJobView; compact?: boolean }) {
  return (
    <div className={`${compact ? "border-t" : ""} border-b border-[var(--line)] p-5`}>
      {!compact ? <p className="eyebrow m-0">Checked selection</p> : null}
      {!compact ? <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">Checked sender groups</h2> : null}
      <div className="mt-3 border-l-4 border-[var(--blue)] bg-sky-50 px-4 py-3 text-sm">
        <strong className="block text-[var(--navy)]">
          {job.selectedSenderGroupCount.toLocaleString()} sender groups selected
        </strong>
        <span className="muted block">{job.selectedReadyCount.toLocaleString()} Suggested emails were available</span>
        <span className="muted block">
          {job.contributingSenderGroupCount.toLocaleString()} sender groups contributed to this {job.requestedCount.toLocaleString()}-message check
        </span>
      </div>
    </div>
  );
}

function FrozenSenderRows({ groups, bounded = false }: { groups: CleanupSenderGroup[]; bounded?: boolean }) {
  return (
    <ul
      aria-label="Checked sender groups"
      className={`m-0 list-none p-0 ${bounded ? "focus-ring lg:max-h-[calc(100vh-18rem)] lg:min-h-[360px] lg:overflow-y-auto" : ""}`}
      tabIndex={bounded ? 0 : undefined}
    >
      {groups.map((group) => (
        <li
          className="grid gap-3 border-b border-[var(--line)] px-5 py-4 last:border-b-0 lg:grid-cols-[minmax(180px,1fr)_minmax(150px,190px)_repeat(3,70px)] lg:items-center"
          key={group.index}
        >
          <span className="min-w-0">
            <strong className="block truncate text-[var(--navy)]">{group.displayName}</strong>
            <span className="muted block truncate text-xs">{group.secondaryLabel}</span>
          </span>
          <span>
            <span className={`inline-flex border px-2 py-1 text-xs font-extrabold ${recommendationBadgeClass(group)}`}>
              {recommendationLabel(group)}
            </span>
          </span>
          <FrozenMetric label="Suggested" value={group.cleanupCandidateCount} strong />
          <FrozenMetric label="Review" value={group.reviewMessages} />
          <FrozenMetric label="Protected" value={group.protectedMessages} />
        </li>
      ))}
    </ul>
  );
}

function FrozenMetric({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <span className={`flex justify-between gap-3 text-sm lg:block lg:text-right ${strong ? "font-extrabold text-[var(--navy)]" : ""}`}>
      <span className="muted lg:hidden">{label}</span>
      {value.toLocaleString()}
    </span>
  );
}

function recommendationLabel(group: CleanupSenderGroup) {
  if (group.cleanupConfidence === "very_high") return "Very High";
  if (group.cleanupConfidence === "high") return "High";
  if (group.cleanupConfidence === "review") return "Review";
  return "Keep";
}

function ineligibleLabel(group: CleanupSenderGroup) {
  if (group.ineligibleReason === "REVIEW_GROUP") return "Not selectable: needs review";
  if (group.ineligibleReason === "KEEP_GROUP") return "Not selectable: Keep";
  if (group.ineligibleReason === "PROTECTED_SENDER") return "Not selectable: protected sender";
  return "0 suggested";
}

function ineligibleExplanation(group: CleanupSenderGroup) {
  if (group.ineligibleReason === "REVIEW_GROUP") return "Not enough evidence to clean automatically.";
  if (group.ineligibleReason === "PROTECTED_SENDER") return "These messages look important or protected.";
  if (group.ineligibleReason === "KEEP_GROUP") return "No emails from this sender are currently suggested for cleanup.";
  return "Nothing available to clean automatically.";
}

function recommendationBadgeClass(group: CleanupSenderGroup) {
  if (group.eligible) return "border-emerald-300 bg-emerald-50 text-emerald-900";
  if (group.cleanupConfidence === "review") return "border-amber-300 bg-amber-50 text-amber-950";
  return "border-neutral-400 bg-white text-neutral-800";
}

function Metric({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <span className={`flex justify-between gap-3 text-sm md:block md:text-right ${strong ? "font-extrabold text-[var(--navy)]" : ""}`}><span className="muted md:hidden">{label}</span>{value.toLocaleString()}</span>;
}

function PreviewAccounting({ job }: { job: GmailCleanupJobView }) {
  return <dl className="mt-3 grid gap-2 text-sm"><Row label="Suggested in selection" value={job.reportReadyCount.toLocaleString()} /><Row label="Rechecked now" value={job.resolvedCount.toLocaleString()} /><Row label="Excluded during safety checks" value={job.excludedMessageCount.toLocaleString()} /></dl>;
}

function SenderGroupFailureNotice({ job }: { job: GmailCleanupJobView }) {
  if (job.senderGroupResolution.failedCount === 0) return null;
  const singular = job.senderGroupResolution.failedCount === 1;
  return (
    <Notice
      text={`${job.senderGroupResolution.failedCount.toLocaleString()} sender ${singular ? "group couldn't" : "groups couldn't"} be checked safely, so we left ${singular ? "it" : "them"} alone.`}
    />
  );
}

function CompletedResult({ job, busy, onUndo, onRescan }: { job: GmailCleanupJobView; busy: boolean; onUndo: () => void; onRescan: () => void }) {
  return <div className="mt-4 grid gap-2 border-t border-[var(--line)] pt-4"><p className="m-0 text-xl font-extrabold text-[var(--navy)]">{job.verifiedTrashCount.toLocaleString()} emails moved to Trash.</p><p className="muted m-0 text-sm">They&apos;re still recoverable in Gmail Trash.</p>{job.undoAvailable ? <button className="btn btn-secondary focus-ring w-full" disabled={busy} onClick={onUndo} type="button">Undo</button> : null}<button className="btn btn-primary focus-ring w-full" disabled={busy} onClick={onRescan} type="button">Rescan inbox</button><ContextBackAction className="w-full" href="/app/report" label="Back to Inbox Report" /></div>;
}

function PartialResult({ job, busy, onRescan }: { job: GmailCleanupJobView; busy: boolean; onRescan: () => void }) {
  return <div className="mt-4 grid gap-2 border-t border-[var(--line)] pt-4"><Notice text="Trash verification was not complete. Rescan and inspect Gmail Trash before continuing." /><dl className="grid gap-2 text-sm"><Row label="Attempted" value={job.attemptedCount.toLocaleString()} /><Row label="Verified" value={job.verifiedCount.toLocaleString()} /><Row label="Failed" value={job.failedCount.toLocaleString()} /><Row label="Uncertain" value={job.uncertainCount.toLocaleString()} /></dl><button className="btn btn-primary focus-ring w-full" disabled={busy} onClick={onRescan} type="button">Rescan inbox</button></div>;
}

function UndoResult({ job, busy, onRescan }: { job: GmailCleanupJobView; busy: boolean; onRescan: () => void }) {
  return <div className="mt-4 grid gap-2 border-t border-[var(--line)] pt-4"><p className="m-0 text-lg font-extrabold text-[var(--navy)]">{job.status === "undone" ? `${job.undoVerifiedCount.toLocaleString()} messages restored from Trash.` : "Restore verification was not complete."}</p><dl className="grid gap-2 text-sm"><Row label="Attempted restore" value={job.undoAttemptedCount.toLocaleString()} /><Row label="Verified restored" value={job.undoVerifiedCount.toLocaleString()} /><Row label="Failed" value={job.undoFailedCount.toLocaleString()} /><Row label="Uncertain" value={job.undoUncertainCount.toLocaleString()} /></dl><button className="btn btn-primary focus-ring w-full" disabled={busy} onClick={onRescan} type="button">Rescan inbox</button><ContextBackAction className="w-full" href="/app/report" label="Back to Inbox Report" /></div>;
}

function CleanupOperationStatus({
  operation,
  requestedCount,
  job,
  startedAt
}: {
  operation: ActiveCleanupOperation;
  requestedCount: number;
  job: GmailCleanupJobView | null;
  startedAt?: number;
}) {
  if (operation === "resolution") {
    return (
      <OperationStatus
        description="We're rechecking them against Gmail before anything is moved."
        startedAt={startedAt}
        title={`Checking ${requestedCount.toLocaleString()} messages...`}
      />
    );
  }
  if (operation === "benchmark") {
    return (
      <OperationStatus
        description="We're running the non-mutating Gmail safety checks."
        startedAt={startedAt}
        title="Running safety benchmark..."
      />
    );
  }
  if (operation === "undo") {
    return (
      <OperationStatus
        description="We're restoring the verified cleanup batch and checking the result."
        startedAt={startedAt}
        title={`Restoring ${(job?.attemptedCount ?? requestedCount).toLocaleString()} messages...`}
      />
    );
  }
  if (operation === "rescan") {
    return (
      <OperationStatus
        description="We're safely checking your mailbox and rebuilding your Inbox Report."
        startedAt={startedAt}
        title="Rescanning your inbox..."
      />
    );
  }
  if (operation === "start_over") {
    return (
      <OperationStatus
        description="We're discarding this checked snapshot and restoring your selection."
        startedAt={startedAt}
        title="Starting over..."
      />
    );
  }
  const verifying = job?.operationStates.trashVerification === "in_progress";
  return (
    <OperationStatus
      description={
        verifying
          ? "We're checking Gmail before announcing the final result."
          : "The confirmation is locked while this one cleanup operation runs."
      }
      startedAt={startedAt}
      title={
        verifying
          ? "Messages moved. Verifying cleanup..."
          : `Moving ${(job?.resolvedCount ?? requestedCount).toLocaleString()} messages to Trash...`
      }
    />
  );
}

function DevelopmentCleanupDetails({ job }: { job: GmailCleanupJobView }) {
  return <details className="mt-4 border-t border-[var(--line)] pt-3 text-sm"><summary className="cursor-pointer font-bold text-[var(--navy)]">Development cleanup details</summary><dl className="mt-3 grid gap-2"><Row label="Sender groups" value={job.contributingSenderGroupCount.toLocaleString()} /><Row label="Provider requests" value={job.requestProfile.requestCount.toLocaleString()} /><Row label="Retries" value={job.requestProfile.retryCount.toLocaleString()} /><Row label="Peak concurrency" value={job.requestProfile.peakConcurrency.toLocaleString()} /><Row label="Full preview safety" value={`${job.previewSafetyCheckMs.toLocaleString()} ms`} /><Row label="Confirmation safety" value={`${job.finalSafetyRecheckMs.toLocaleString()} ms`} /><Row label="Request p95" value={`${job.requestProfile.durationP95Ms.toLocaleString()} ms`} /><Row label="Estimated quota" value={job.requestProfile.estimatedQuotaUnits.toLocaleString()} /><Row label="Estimated 1,000-message quota" value={job.estimatedThousandMessageQuotaUnits.toLocaleString()} /></dl><CopyCleanupSummaryButton job={job} /></details>;
}

function CopyCleanupSummaryButton({ job }: { job: GmailCleanupJobView }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(formatDevelopmentCleanupSummary(job)); setStatus("copied"); }
    catch { setStatus("failed"); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 1600);
  }
  return <button className="btn btn-secondary focus-ring mt-4 text-sm" onClick={copy} type="button"><span aria-live="polite">{status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy cleanup summary"}</span></button>;
}

function Notice({ text }: { text: string }) {
  return <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-[var(--navy)]">{text}</p>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-4"><dt className="muted">{label}</dt><dd className="m-0 text-right font-bold">{value}</dd></div>;
}
