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
import {
  getSessionAdjustedSuggestedCount,
  getSessionAdjustedSuggestedTotal
} from "@/lib/domain/cleanup-session-adjustments";
import {
  getCleanupWorkspaceState,
  type CleanupWorkspaceOperation,
  type CleanupWorkspaceState
} from "@/lib/domain/cleanup-workspace-state";
import { getGmailCleanupRequestMode } from "@/lib/domain/gmail-cleanup-request-mode";
import { formatDevelopmentBulkUndoProofSummary } from "@/lib/domain/gmail-bulk-undo-proof-summary";
import {
  getGmailScalableDiagnosticSnapshot,
  getGmailScalableJobProgress,
  shouldPollGmailScalableJob,
  type GmailScalableJobView
} from "@/lib/domain/gmail-scalable-cleanup";
import { formatDevelopmentCleanupSummary, type GmailCleanupJobView } from "@/lib/domain/gmail-cleanup-summary";
import type { CleanupSenderGroup } from "@/lib/providers/gmail/cleanup-candidates";

type ActiveCleanupOperation = CleanupWorkspaceOperation;

export function GmailCleanupClient({
  groups,
  bulkUndoProofEnabled,
  cleanupEnabled,
  legacyCleanupMaximum,
  scalableCleanupEnabled,
  fixtureMode,
  initialScalableJob,
  countOptions,
  reportStale,
  developmentMode
}: {
  groups: CleanupSenderGroup[];
  bulkUndoProofEnabled: boolean;
  cleanupEnabled: boolean;
  legacyCleanupMaximum: number;
  scalableCleanupEnabled: boolean;
  fixtureMode: boolean;
  initialScalableJob?: GmailScalableJobView;
  countOptions: number[];
  reportStale: boolean;
  developmentMode: boolean;
}) {
  const router = useRouter();
  const [selectedGroupIndices, setSelectedGroupIndices] = useState<Set<number>>(
    () => initialScalableJob ? new Set(initialScalableJob.groupIndices) : createDefaultCleanupSelection(groups)
  );
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<CleanupSortKey>("ready");
  const [requestedCount, setRequestedCount] = useState(initialScalableJob?.requestedCount ?? countOptions.at(-1) ?? 0);
  const [job, setJob] = useState<GmailCleanupJobView | null>(null);
  const [scalableJob, setScalableJob] = useState<GmailScalableJobView | null>(initialScalableJob ?? null);
  const [checkedGroupIndices, setCheckedGroupIndices] = useState<number[]>(initialScalableJob?.groupIndices ?? []);
  const [reviewStarted, setReviewStarted] = useState(Boolean(initialScalableJob));
  const [snapshotExpired, setSnapshotExpired] = useState(false);
  const [finalStep, setFinalStep] = useState(false);
  const [activeOperation, setActiveOperation] = useState<ActiveCleanupOperation | null>(null);
  const [operationStartedAt, setOperationStartedAt] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const activeOperationRef = useRef<ActiveCleanupOperation | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);

  const scalablePollingActive = scalableJob ? shouldPollGmailScalableJob(scalableJob) : false;
  const scalableRunning = scalablePollingActive;
  const scalableJobId = scalableJob?.id;
  const busy = activeOperation !== null || scalableRunning;
  const activeJobId = job?.id;

  const visibleGroups = useMemo(() => filterAndSortCleanupGroups(groups, search, sortKey), [groups, search, sortKey]);
  const selectedGroups = groups.filter((group) => selectedGroupIndices.has(group.index));
  const selectedReadyCount = selectedGroups.reduce((total, group) => total + group.cleanupCandidateCount, 0);
  const selectedReviewCount = selectedGroups.reduce((total, group) => total + group.reviewMessages, 0);
  const selectedProtectedCount = selectedGroups.reduce((total, group) => total + group.protectedMessages, 0);
  const groupsByIndex = useMemo(() => new Map(groups.map((group) => [group.index, group])), [groups]);
  const checkedGroups = checkedGroupIndices.flatMap((index) => {
    const group = groupsByIndex.get(index);
    return group ? [group] : [];
  });
  const workspaceState = getCleanupWorkspaceState({
    reviewStarted,
    snapshotExpired,
    activeOperation,
    jobStatus: job?.status,
    mutationStarted: job?.mutationStarted,
    operationStates: job?.operationStates
  });
  const showFrozenSenderContext = workspaceState.showFrozenSenderContext && Boolean(job);
  const primaryWorkspaceOperationActive = activeOperation === "trash" || activeOperation === "undo";
  const eligibleIndices = eligibleCleanupGroupIndices(groups);
  const visibleEligibleIndices = visibleGroups.filter((group) => group.eligible).map((group) => group.index);
  const allVisibleEligibleSelected =
    visibleEligibleIndices.length > 0 && visibleEligibleIndices.every((index) => selectedGroupIndices.has(index));
  const cleanupRequestMode = getGmailCleanupRequestMode({
    requestedCount,
    legacyMaximum: legacyCleanupMaximum,
    scalableEnabled: scalableCleanupEnabled
  });
  const requestModeEnabled =
    cleanupRequestMode === "legacy"
      ? cleanupEnabled
      : cleanupRequestMode === "scalable";
  const disabled =
    !requestModeEnabled ||
    fixtureMode ||
    reportStale ||
    selectedGroupIndices.size === 0 ||
    requestedCount > selectedReadyCount ||
    busy;

  function resetPreview() {
    setJob(null);
    setScalableJob(null);
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
    if (!scalableJobId || !scalablePollingActive) return;
    let cancelled = false;
    const poll = async () => {
      const response = await fetch("/api/dev/gmail-scalable-cleanup/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: scalableJobId })
      });
      if (!response.ok || cancelled) return;
      const body = (await response.json()) as { job?: GmailScalableJobView };
      if (body.job) setScalableJob(body.job);
    };
    void poll();
    const interval = window.setInterval(poll, 750);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [scalableJobId, scalablePollingActive]);

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
    if (cleanupRequestMode === "invalid") {
      setError("Choose a supported cleanup count.");
      return;
    }
    const operation = benchmarkOnly ? "benchmark" : "resolution";
    if (!beginOperation(operation)) return;
    const groupIndices = [...selectedGroupIndices];
    setError(null);
    setFinalStep(false);
    try {
      const scalable = cleanupRequestMode === "scalable";
      const response = await fetch(scalable ? "/api/dev/gmail-scalable-cleanup/start" : "/api/dev/gmail-cleanup/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupIndices, requestedCount, benchmarkOnly })
      });
      const body = (await response.json()) as { job?: GmailCleanupJobView | GmailScalableJobView; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? "We couldn't check these messages. Try again.");
      if (scalable) {
        setScalableJob(body.job as GmailScalableJobView);
        setCheckedGroupIndices(groupIndices);
        setReviewStarted(true);
      } else {
        setJob(body.job as GmailCleanupJobView);
      }
      setSnapshotExpired(false);
      if (!scalable && !benchmarkOnly && body.job.status === "ready") {
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
    const activeJob = scalableJob ?? job;
    if (!activeJob || !beginOperation("trash")) return;
    setError(null);
    try {
      const response = await fetch(scalableJob ? "/api/dev/gmail-scalable-cleanup/confirm" : "/api/dev/gmail-cleanup/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: activeJob.id, confirmation: "MOVE_TO_TRASH" })
      });
      const body = (await response.json()) as { job?: GmailCleanupJobView | GmailScalableJobView; error?: string };
      if (response.status === 410) {
        setSnapshotExpired(true);
        setFinalStep(false);
        return;
      }
      if (!response.ok || !body.job) throw new Error(body.error ?? "We couldn't move these messages to Trash. Try again.");
      if (scalableJob) setScalableJob(body.job as GmailScalableJobView);
      else setJob(body.job as GmailCleanupJobView);
      setSnapshotExpired(false);
      setFinalStep(false);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "We couldn't move these messages to Trash. Try again.");
    } finally {
      finishOperation("trash");
    }
  }

  async function startOver() {
    const activeJob = scalableJob ?? job;
    if (!activeJob || !beginOperation("start_over")) return;
    setError(null);
    try {
      const response = await fetch(scalableJob ? "/api/dev/gmail-scalable-cleanup/discard" : "/api/dev/gmail-cleanup/start-over", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: activeJob.id })
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
    const activeJob = scalableJob ?? job;
    if (!activeJob || !beginOperation("undo")) return;
    setError(null);
    try {
      const response = await fetch(scalableJob ? "/api/dev/gmail-scalable-cleanup/undo" : "/api/dev/gmail-cleanup/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: activeJob.id,
          ...(scalableJob ? { confirmation: "RESTORE_FROM_TRASH" } : {})
        })
      });
      const body = (await response.json()) as { job?: GmailCleanupJobView | GmailScalableJobView; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? "We couldn't restore these messages. Try again.");
      if (scalableJob) setScalableJob(body.job as GmailScalableJobView);
      else setJob(body.job as GmailCleanupJobView);
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : "We couldn't restore these messages. Try again.");
    } finally {
      finishOperation("undo");
    }
  }

  async function runBulkUndoProof() {
    if (!job || !beginOperation("bulk_undo_proof")) return;
    setError(null);
    try {
      const response = await fetch("/api/dev/gmail-bulk-undo-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, approved: true })
      });
      const body = (await response.json()) as { job?: GmailCleanupJobView; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? "The bulk Undo proof could not be completed.");
      setJob(body.job);
    } catch (proofError) {
      setError(proofError instanceof Error ? proofError.message : "The bulk Undo proof could not be completed.");
    } finally {
      finishOperation("bulk_undo_proof");
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

  if (scalableJob) {
    return (
      <ScalableCleanupWorkspace
        busy={busy}
        error={error}
        finalStep={finalStep}
        groups={checkedGroups}
        job={scalableJob}
        onConfirm={confirmCleanup}
        onRescan={rescanInbox}
        onStartOver={startOver}
        onToggleFinalStep={setFinalStep}
        onUndo={undoCleanup}
        operationStartedAt={operationStartedAt}
        reportGroups={groups}
      />
    );
  }

  return (
    <section
      aria-busy={busy}
      className={showFrozenSenderContext || !reviewStarted
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

      <aside className={`panel p-5 ${showFrozenSenderContext ? "order-1 lg:order-2 lg:sticky lg:top-24" : reviewStarted ? "" : "lg:sticky lg:top-24"}`}>
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
              disabled={(!cleanupEnabled && !scalableCleanupEnabled) || fixtureMode || reportStale || busy}
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
            {!cleanupEnabled && !scalableCleanupEnabled ? <Notice text="Cleanup is not available right now." /> : null}
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
              {cleanupWorkspaceHeading(workspaceState.state, job)}
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

            {primaryWorkspaceOperationActive ? null : snapshotExpired ? (
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
              <CompletedResult
                bulkUndoProofEnabled={bulkUndoProofEnabled}
                busy={busy}
                job={job}
                onBulkUndoProof={runBulkUndoProof}
                onRescan={rescanInbox}
                onUndo={undoCleanup}
              />
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

            {!primaryWorkspaceOperationActive && developmentMode && job.bulkUndoProof && job.bulkUndoProof.state !== "running" ? (
              <BulkUndoProofDiagnostic job={job} />
            ) : null}
            {!primaryWorkspaceOperationActive && developmentMode ? <DevelopmentCleanupDetails job={job} /> : null}
          </div>
        ) : null}
      </aside>
      {showFrozenSenderContext && job ? (
        <FrozenSenderContext
          groups={checkedGroups}
          job={job}
          reportGroups={groups}
          sessionAdjusted={workspaceState.sessionAdjusted}
        />
      ) : null}
    </section>
  );
}

function cleanupWorkspaceHeading(state: CleanupWorkspaceState, job: GmailCleanupJobView) {
  if (state === "moving") return "Moving to Trash";
  if (state === "verifying") return "Verifying cleanup";
  if (state === "undoing") return "Restoring messages";
  if (state === "expired") return "This cleanup check has expired.";
  if (state === "undo_complete") return job.status === "undone" ? "Undo complete" : "Undo result";
  if (state === "complete") return job.status === "completed" ? "Cleanup complete" : "Cleanup result";
  return "Suggested cleanup";
}

function ScalableCleanupWorkspace({
  busy,
  error,
  finalStep,
  groups,
  job,
  onConfirm,
  onRescan,
  onStartOver,
  onToggleFinalStep,
  onUndo,
  operationStartedAt,
  reportGroups
}: {
  busy: boolean;
  error: string | null;
  finalStep: boolean;
  groups: CleanupSenderGroup[];
  job: GmailScalableJobView;
  onConfirm: () => void;
  onRescan: () => void;
  onStartOver: () => void;
  onToggleFinalStep: (value: boolean) => void;
  onUndo: () => void;
  operationStartedAt?: number;
  reportGroups: CleanupSenderGroup[];
}) {
  const progress = getGmailScalableJobProgress(job);
  const working = shouldPollGmailScalableJob(job);
  const sessionAdjusted = job.verifiedCount > 0;
  const hasUndoResult = job.verifiedRestoredCount + job.failedRestoreCount + job.uncertainRestoreCount > 0;
  const frozenJob: FrozenSenderJob = {
    suggestedDeltas: job.suggestedDeltas,
    verifiedCount: job.verifiedCount,
    undoVerifiedCount: job.verifiedRestoredCount,
    selectedSenderGroupCount: groups.length,
    selectedReadyCount: groups.reduce((total, group) => total + group.cleanupCandidateCount, 0),
    contributingSenderGroupCount: groups.length,
    requestedCount: job.requestedCount
  };
  const activeChunk = job.chunks.find((chunk) => ["safety_checking", "mutating", "verifying", "undoing"].includes(chunk.status));
  const chunksComplete = progress.chunksComplete;
  const statusCopy = scalableStatusCopy(job);

  return (
    <section aria-busy={working} className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
      <aside className="panel order-1 p-5 lg:order-2 lg:sticky lg:top-24">
        <div aria-live="polite">
          <p className="eyebrow m-0">{job.requestedCount.toLocaleString()}-message development job</p>
          <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">{scalableHeading(job.status)}</h2>
          {working && statusCopy ? (
            <OperationStatus
              description={statusCopy.description}
              startedAt={activeChunk?.startedAt ?? operationStartedAt ?? job.createdAt}
              title={statusCopy.title}
            />
          ) : null}
          {job.status === "paused" ? <Notice text={job.progressLabel} /> : null}
          {error ? <Notice text={error} /> : null}
          {job.chunkCount > 1 ? (
            <dl className="mt-4 grid gap-2 text-sm">
              <Row label="Chunks complete" value={`${chunksComplete} / ${job.chunkCount}`} />
            </dl>
          ) : null}

          {job.verifiedProcessedCount > 0 && !progress.jobTerminal && job.status !== "undoing" ? (
            <p className="mt-4 font-bold text-[var(--navy)]">
              {job.verifiedProcessedCount.toLocaleString()} messages moved so far
            </p>
          ) : null}

          {job.verifiedProcessedCount > 0 && progress.jobTerminal ? (
            <div className="mt-4">
              <div className="mb-2 flex justify-between gap-3 text-sm font-bold text-[var(--navy)]">
                <span>Approved messages moved</span>
                <span>{job.verifiedProcessedCount.toLocaleString()} / {job.attemptedCount.toLocaleString()}</span>
              </div>
              <progress
                aria-label="Verified cleanup progress"
                className="h-2 w-full accent-[var(--teal)]"
                max={job.attemptedCount}
                value={job.verifiedProcessedCount}
              />
            </div>
          ) : null}

          {job.recoveryRestoreAvailable && (job.recoveryRestoreCount ?? 0) > 0 ? (
            <div className="mt-4 grid gap-2">
              <Notice text={job.recoveryRestoreReason ?? "Only exact verified moved messages will be restored."} />
              <button className="btn btn-secondary focus-ring w-full" onClick={onUndo} type="button">
                Restore {(job.recoveryRestoreCount ?? 0).toLocaleString()} moved messages
              </button>
            </div>
          ) : null}

          {job.status === "ready" ? (
            <>
              <dl className="mt-4 grid gap-2 text-sm">
                <Row label="Messages checked" value={job.requestedCount.toLocaleString()} />
                <Row label="Currently approved" value={job.safeCount.toLocaleString()} />
                <Row label="Currently left alone" value={job.excludedCount.toLocaleString()} />
              </dl>
              {!finalStep ? (
                <div className="mt-5 grid gap-2">
                  <button className="btn btn-primary focus-ring w-full" onClick={() => onToggleFinalStep(true)} type="button">
                    Move up to {job.safeCount.toLocaleString()} to Trash
                  </button>
                  <button className="btn btn-secondary focus-ring w-full" onClick={onStartOver} type="button">Start over</button>
                </div>
              ) : (
                <div className="mt-5 grid gap-2 border-t border-[var(--line)] pt-4">
                  <p className="m-0 font-extrabold text-[var(--navy)]">Move up to {job.safeCount.toLocaleString()} messages to Trash?</p>
                  <p className="muted m-0 text-sm">Each frozen chunk is checked again immediately before it moves. Newly protected messages will be left alone.</p>
                  <button className="btn btn-secondary focus-ring w-full" onClick={() => onToggleFinalStep(false)} type="button">Cancel</button>
                  <button className="btn btn-primary focus-ring w-full" onClick={onConfirm} type="button">Move up to {job.safeCount.toLocaleString()} to Trash</button>
                </div>
              )}
            </>
          ) : null}

          {job.status === "complete" ? (
            <div className="mt-4 grid gap-2">
              <p className="m-0 text-xl font-extrabold text-[var(--navy)]">{job.verifiedCount.toLocaleString()} messages moved to Trash.</p>
              <dl className="grid gap-2 text-sm">
                <Row label="Messages checked" value={job.requestedCount.toLocaleString()} />
                {job.excludedCount > 0 ? <Row label="Left alone after the final safety check" value={job.excludedCount.toLocaleString()} /> : null}
              </dl>
              {job.undoAvailable ? <button className="btn btn-secondary focus-ring w-full" disabled={busy} onClick={onUndo} type="button">Undo {job.verifiedCount.toLocaleString()} messages</button> : null}
              <button className="btn btn-primary focus-ring w-full" disabled={busy} onClick={onRescan} type="button">Rescan inbox</button>
              <ContextBackAction className="w-full" href="/app/report" label="Back to Inbox Report" />
            </div>
          ) : null}

          {job.status === "partial" || job.status === "uncertain" ? (
            <div className="mt-4 grid gap-2">
              <Notice text={hasUndoResult
                ? `${job.verifiedRestoredCount.toLocaleString()} restored, ${job.failedRestoreCount.toLocaleString()} failed, and ${job.uncertainRestoreCount.toLocaleString()} uncertain. Only verified restoration changed the displayed counts.`
                : `${job.verifiedCount.toLocaleString()} verified, ${job.failedCount.toLocaleString()} failed, and ${job.uncertainCount.toLocaleString()} uncertain. No unverified message changed the displayed counts.`} />
              <button className="btn btn-primary focus-ring w-full" disabled={busy} onClick={onRescan} type="button">Rescan inbox</button>
              <ContextBackAction className="w-full" href="/app/report" label="Back to Inbox Report" />
            </div>
          ) : null}

          {job.status === "undo_complete" ? (
            <div className="mt-4 grid gap-2">
              <p className="m-0 text-xl font-extrabold text-[var(--navy)]">{job.verifiedRestoredCount.toLocaleString()} messages restored from Trash.</p>
              <Row label="Attempted restore" value={(job.verifiedRestoredCount + job.failedRestoreCount + job.uncertainRestoreCount).toLocaleString()} />
              <Row label="Verified restored" value={job.verifiedRestoredCount.toLocaleString()} />
              <Row label="Failed" value={job.failedRestoreCount.toLocaleString()} />
              <Row label="Uncertain" value={job.uncertainRestoreCount.toLocaleString()} />
              <button className="btn btn-primary focus-ring w-full" disabled={busy} onClick={onRescan} type="button">Rescan inbox</button>
              <ContextBackAction className="w-full" href="/app/report" label="Back to Inbox Report" />
            </div>
          ) : null}

          {job.status === "failed" ? (
            <div className="mt-4">
              <Notice text={job.error ?? (job.verifiedCount > 0
                ? `The scalable cleanup job stopped after ${job.verifiedCount.toLocaleString()} exact messages were verified in Trash.`
                : "The scalable cleanup job stopped safely. Nothing was moved.")} />
              {job.attemptedCount === 0 ? <button className="btn btn-secondary focus-ring mt-4 w-full" onClick={onStartOver} type="button">Start over</button> : null}
            </div>
          ) : null}

          <ScalablePostStateAuditDetails job={job} />
          <CopyScalableCleanupSummaryButton job={job} />
        </div>
      </aside>
      <FrozenSenderContext groups={groups} job={frozenJob} reportGroups={reportGroups} sessionAdjusted={sessionAdjusted} />
    </section>
  );
}

function ScalablePostStateAuditDetails({ job }: { job: GmailScalableJobView }) {
  const audit = job.postStateAudit;
  if (!audit) return null;
  return (
    <details className="mt-4 border-t border-[var(--line)] pt-3 text-sm" open>
      <summary className="cursor-pointer font-bold text-[var(--navy)]">Development post-state audit</summary>
      <dl className="mt-3 grid gap-2">
        {audit.cleanup ? (
          <>
            <Row label="Cleanup attempted messages" value={audit.cleanup.targetCount.toLocaleString()} />
            <Row label="History verified messages" value={audit.cleanup.authoritativeHistoryVerifiedCount.toLocaleString()} />
            <Row label="Exact target messages found in Trash" value={audit.cleanup.exactTargetMessagesFoundInTrash.toLocaleString()} />
            <Row label="Exact target messages missing from Trash" value={audit.cleanup.exactTargetMessagesAbsentFromTrash.toLocaleString()} />
            <Row label="Distinct Gmail threads for target messages" value={audit.cleanup.distinctGmailThreadCount.toLocaleString()} />
            <Row label="Trash list requests" value={audit.cleanup.trashListRequests.toLocaleString()} />
            <Row label="Trash list pages" value={audit.cleanup.trashListPages.toLocaleString()} />
            <Row label="History vs Trash-state mismatch" value={audit.cleanup.mismatchCount.toLocaleString()} />
            {audit.cleanup.error ? <p className="muted m-0">{audit.cleanup.error}</p> : null}
          </>
        ) : null}
        {audit.undo ? (
          <>
            <Row label="Undo verified restored" value={audit.undo.targetCount.toLocaleString()} />
            <Row label="Exact restored targets still found in Trash" value={audit.undo.exactTargetMessagesFoundInTrash.toLocaleString()} />
            <Row label="Exact restored targets absent from Trash" value={audit.undo.exactTargetMessagesAbsentFromTrash.toLocaleString()} />
            <Row label="Undo history vs Trash-state mismatch" value={audit.undo.mismatchCount.toLocaleString()} />
            {audit.undo.error ? <p className="muted m-0">{audit.undo.error}</p> : null}
          </>
        ) : null}
        <Row label="Development audit units" value={job.developmentAuditQuotaUnits.toLocaleString()} />
      </dl>
    </details>
  );
}

function scalableHeading(status: GmailScalableJobView["status"]) {
  if (status === "created" || status === "safety_checking") return "Checking messages";
  if (status === "ready") return "Suggested cleanup";
  if (status === "mutating") return "Moving to Trash";
  if (status === "verifying") return "Verifying cleanup";
  if (status === "chunk_complete") return "Continuing cleanup";
  if (status === "complete") return "Cleanup complete";
  if (status === "undoing") return "Restoring messages";
  if (status === "undo_complete") return "Undo complete";
  if (status === "paused") return "Cleanup paused";
  if (status === "failed") return "Cleanup stopped";
  return "Cleanup result";
}

function scalableStatusCopy(job: GmailScalableJobView) {
  const activeChunk = job.chunks.find((chunk) => ["safety_checking", "ready", "mutating", "verifying", "undoing"].includes(chunk.status));
  const chunkContext = activeChunk && job.chunkCount > 1 ? ` Chunk ${activeChunk.index + 1} of ${job.chunkCount}.` : "";
  if (job.status === "created" || job.status === "safety_checking") {
    return { title: `Checking ${job.requestedCount.toLocaleString()} messages...`, description: `We're rechecking the exact Gmail messages before anything moves.${chunkContext}` };
  }
  if (job.status === "mutating") {
    return { title: "Moving approved messages to Trash...", description: `We're moving the approved cleanup chunk to Gmail Trash.${chunkContext}` };
  }
  if (job.status === "verifying") {
    return { title: "Verifying approved messages...", description: `We're checking exact Gmail history before updating your counts.${chunkContext}` };
  }
  if (job.status === "chunk_complete") {
    const progress = getGmailScalableJobProgress(job);
    return progress.nextChunk
      ? {
          title: `Preparing chunk ${progress.nextChunk} of ${job.chunkCount}...`,
          description: `${job.verifiedCount.toLocaleString()} messages moved so far. We're continuing with the next frozen cleanup chunk.`
        }
      : {
          title: "Finalizing cleanup...",
          description: `${job.verifiedCount.toLocaleString()} messages moved. We're finalizing the durable cleanup result.`
        };
  }
  if (job.status === "undoing") {
    return { title: `Restoring ${job.verifiedCount.toLocaleString()} messages...`, description: `We're restoring the verified chunk and checking the result.${chunkContext}` };
  }
  return undefined;
}

function CopyScalableCleanupSummaryButton({ job }: { job: GmailScalableJobView }) {
  const diagnostic = getGmailScalableDiagnosticSnapshot(job);
  const [copiedDiagnosticKey, setCopiedDiagnosticKey] = useState<string>();
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  return (
    <button
      className="btn btn-secondary focus-ring mt-4 w-full"
      onClick={async () => {
        await navigator.clipboard.writeText(diagnostic.content);
        setCopiedDiagnosticKey(diagnostic.key);
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopiedDiagnosticKey(undefined), 2_000);
      }}
      type="button"
    >
      {copiedDiagnosticKey === diagnostic.key ? "Copied" : "Copy development summary"}
    </button>
  );
}

type FrozenSenderJob = {
  suggestedDeltas: Array<{ groupIndex: number; verifiedMovedCount: number; verifiedRestoredCount: number }>;
  verifiedCount: number;
  undoVerifiedCount: number;
  selectedSenderGroupCount: number;
  selectedReadyCount: number;
  contributingSenderGroupCount: number;
  requestedCount: number;
};

function FrozenSenderContext({
  groups,
  job,
  reportGroups,
  sessionAdjusted
}: {
  groups: CleanupSenderGroup[];
  job: FrozenSenderJob;
  reportGroups: CleanupSenderGroup[];
  sessionAdjusted: boolean;
}) {
  const suggestedDeltas = job.suggestedDeltas ?? [];
  const deltasByGroup = new Map(suggestedDeltas.map((delta) => [delta.groupIndex, delta]));
  const adjustedReportSuggested = getSessionAdjustedSuggestedTotal(reportGroups, suggestedDeltas);
  return (
    <section aria-label={sessionAdjusted ? "Updated sender context" : "Frozen sender context"} className="order-2 lg:order-1">
      <div className="panel hidden overflow-hidden lg:block">
        <FrozenSenderSummary adjustedReportSuggested={adjustedReportSuggested} job={job} sessionAdjusted={sessionAdjusted} />
        <div className="grid grid-cols-[minmax(180px,1fr)_minmax(150px,190px)_repeat(3,70px)] gap-3 border-b border-[var(--line)] bg-[var(--surface-subtle)] px-5 py-2 text-xs font-bold text-[var(--navy)]">
          <span>Sender</span>
          <span>Recommendation</span>
          <span className="text-right">Suggested</span>
          <span className="text-right">Review</span>
          <span className="text-right">Protected</span>
        </div>
        <FrozenSenderRows deltasByGroup={deltasByGroup} groups={groups} bounded sessionAdjusted={sessionAdjusted} />
      </div>

      <details className="panel overflow-hidden lg:hidden">
        <summary className="focus-ring cursor-pointer px-5 py-4 font-extrabold text-[var(--navy)]">
          {sessionAdjusted ? "Updated sender groups" : "Checked sender groups"}
          <span className="muted ml-2 text-sm font-normal">{groups.length.toLocaleString()}</span>
        </summary>
        <FrozenSenderSummary adjustedReportSuggested={adjustedReportSuggested} job={job} compact sessionAdjusted={sessionAdjusted} />
        <FrozenSenderRows deltasByGroup={deltasByGroup} groups={groups} sessionAdjusted={sessionAdjusted} />
      </details>
    </section>
  );
}

function FrozenSenderSummary({
  adjustedReportSuggested,
  job,
  compact = false,
  sessionAdjusted
}: {
  adjustedReportSuggested: number;
  job: FrozenSenderJob;
  compact?: boolean;
  sessionAdjusted: boolean;
}) {
  return (
    <div className={`${compact ? "border-t" : ""} border-b border-[var(--line)] p-5`}>
      {!compact ? <p className="eyebrow m-0">{sessionAdjusted ? "Cleanup context" : "Checked selection"}</p> : null}
      {!compact ? <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">{sessionAdjusted ? "Updated sender groups" : "Checked sender groups"}</h2> : null}
      <div className="mt-3 border-l-4 border-[var(--blue)] bg-sky-50 px-4 py-3 text-sm">
        {sessionAdjusted ? (
          <>
            <strong className="block text-[var(--navy)]">{adjustedReportSuggested.toLocaleString()} Suggested emails remaining</strong>
            <span className="muted block">{job.verifiedCount.toLocaleString()} moved to Trash in this cleanup</span>
            {job.undoVerifiedCount > 0 ? <span className="muted block">{job.undoVerifiedCount.toLocaleString()} restored from Trash</span> : null}
            <span className="muted mt-2 block">Updated from the messages Organizinbox just handled. Rescan to refresh the whole inbox.</span>
          </>
        ) : (
          <>
            <strong className="block text-[var(--navy)]">{job.selectedSenderGroupCount.toLocaleString()} sender groups selected</strong>
            <span className="muted block">{job.selectedReadyCount.toLocaleString()} Suggested emails were available</span>
            <span className="muted block">{job.contributingSenderGroupCount.toLocaleString()} sender groups contributed to this {job.requestedCount.toLocaleString()}-message check</span>
          </>
        )}
      </div>
    </div>
  );
}

function FrozenSenderRows({
  deltasByGroup,
  groups,
  bounded = false,
  sessionAdjusted
}: {
  deltasByGroup: ReadonlyMap<number, FrozenSenderJob["suggestedDeltas"][number]>;
  groups: CleanupSenderGroup[];
  bounded?: boolean;
  sessionAdjusted: boolean;
}) {
  return (
    <ul
      aria-label={sessionAdjusted ? "Updated sender groups" : "Checked sender groups"}
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
          <FrozenMetric
            label="Suggested"
            value={sessionAdjusted
              ? getSessionAdjustedSuggestedCount(group.cleanupCandidateCount, deltasByGroup.get(group.index))
              : group.cleanupCandidateCount}
            strong
          />
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

function CompletedResult({
  bulkUndoProofEnabled,
  job,
  busy,
  onBulkUndoProof,
  onUndo,
  onRescan
}: {
  bulkUndoProofEnabled: boolean;
  job: GmailCleanupJobView;
  busy: boolean;
  onBulkUndoProof: () => void;
  onUndo: () => void;
  onRescan: () => void;
}) {
  const canRunBulkUndoProof =
    bulkUndoProofEnabled &&
    job.attemptedCount === 25 &&
    job.verifiedCount === 25 &&
    job.failedCount === 0 &&
    job.uncertainCount === 0 &&
    !job.bulkUndoProof;
  return <div className="mt-4 grid gap-2 border-t border-[var(--line)] pt-4"><p className="m-0 text-xl font-extrabold text-[var(--navy)]">{job.verifiedTrashCount.toLocaleString()} emails moved to Trash.</p><p className="muted m-0 text-sm">They&apos;re still recoverable in Gmail Trash.</p>{canRunBulkUndoProof ? <button className="btn btn-secondary focus-ring w-full" disabled={busy} onClick={onBulkUndoProof} type="button">Run bulk Undo proof</button> : null}{job.undoAvailable ? <button className="btn btn-secondary focus-ring w-full" disabled={busy} onClick={onUndo} type="button">Undo</button> : null}<button className="btn btn-primary focus-ring w-full" disabled={busy} onClick={onRescan} type="button">Rescan inbox</button><ContextBackAction className="w-full" href="/app/report" label="Back to Inbox Report" /></div>;
}

function PartialResult({ job, busy, onRescan }: { job: GmailCleanupJobView; busy: boolean; onRescan: () => void }) {
  return <div className="mt-4 grid gap-2 border-t border-[var(--line)] pt-4"><Notice text="Trash verification was not complete. Rescan and inspect Gmail Trash before continuing." /><dl className="grid gap-2 text-sm"><Row label="Attempted" value={job.attemptedCount.toLocaleString()} /><Row label="Verified" value={job.verifiedCount.toLocaleString()} /><Row label="Failed" value={job.failedCount.toLocaleString()} /><Row label="Uncertain" value={job.uncertainCount.toLocaleString()} /></dl><button className="btn btn-primary focus-ring w-full" disabled={busy} onClick={onRescan} type="button">Rescan inbox</button><ContextBackAction className="w-full" href="/app/report" label="Back to Inbox Report" /></div>;
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
  if (operation === "bulk_undo_proof") {
    return (
      <OperationStatus
        description="We're testing one batch restore and verifying all 25 exact messages."
        startedAt={startedAt}
        title="Running bulk Undo proof..."
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
          ? "We're checking that the messages reached Trash."
          : "We're moving the verified cleanup batch to Gmail Trash."
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

function BulkUndoProofDiagnostic({ job }: { job: GmailCleanupJobView }) {
  const proof = job.bulkUndoProof;
  if (!proof) return null;
  return (
    <details className="mt-4 border-t border-[var(--line)] pt-3 text-sm" open>
      <summary className="cursor-pointer font-bold text-[var(--navy)]">Development bulk Undo proof</summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-950 p-4 text-xs text-white">
        {formatDevelopmentBulkUndoProofSummary(proof)}
      </pre>
      <CopyBulkUndoProofSummaryButton job={job} />
    </details>
  );
}

function CopyBulkUndoProofSummaryButton({ job }: { job: GmailCleanupJobView }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    if (!job.bulkUndoProof) return;
    try {
      await navigator.clipboard.writeText(formatDevelopmentBulkUndoProofSummary(job.bulkUndoProof));
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 1600);
  }
  return <button className="btn btn-secondary focus-ring mt-3 text-sm" onClick={copy} type="button"><span aria-live="polite">{status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy bulk Undo proof"}</span></button>;
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
