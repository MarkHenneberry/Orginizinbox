# Outlook targeted verification timing

Measurement only. No batch/concurrency, safety, credit, polling-interval or cleanup
changes. No new database writes, tables, secrets or feature flags. No live requests
are performed by tests. The browser sends one additional authenticated telemetry
POST on ready render (one session-validation read, no database write).

## What the old number means

`totalVerificationDurationMs` sums time inside `prepareOutlookJob` over its chunks.
It includes folder/participation preparation, Graph calls and some persistence.
It excludes per-step job claiming/loading, forward authorization/entitlement,
credential resolution, final save after the timer, aggregate job updates, lease
release, Workflow handoffs, and browser request/poll/render overhead. It is not pure
Graph transport time. Production now advances up to five sequential at-most-20-message
verification batches per Workflow step, yielding between batches after a 15-second
preparation budget. 500 clean approvals normally need five steps, not 25; exclusions
or slow calls may require more. Each batch retains its encrypted cursor/decision
checkpoint. See [chunking analysis](outlook-verification-chunks.md) for the baseline,
operation model and recovery limits.

The successful Outlook start handler does not navigate or call `router.refresh`.
It sets local job/review state; active status polls replace that state until ready.
Existing adaptive polling waits 1/2/3 seconds between completed requests, remains
single-flight, pauses when hidden, and stops at ready/failed/expired. Slow status
responses can add latency beyond the interval. None of that scheduling was changed.

## Correlation and logs

The start route generates a fresh random UUID, unrelated to user/job/mailbox IDs.
It returns `X-Outlook-Verification-Id`. Only aggregate timing context travels with
Workflow arguments/results; no telemetry enters Prisma state. The client echoes
the correlation header on its existing status requests. Correlation is not authority:
all existing origin/session/provider/job/credit checks remain unchanged. Old jobs,
development flows and Gmail continue without an active trace. Reused acceptance
is labelled `reused: true`; do not treat it as a fresh benchmark.

- `Outlook verification timing`: correlationId, unit (start/worker/status), step,
  fixed stage, durationMs, invocation count, cumulativeMs at that stage's last end.
  Spans are combined by stage within each unit rather than logging each SQL call.
  Start/worker cumulative time uses the start request's server origin; status-unit
  time is local to that status request. It is not browser elapsed time.
- `Outlook targeted verification progress/complete`: existing metrics with correlationId.
- `Outlook verification end-to-end`: one ready/failed preparation summary after
  the worker finishes persistence, aggregate sync and lease release.
- `Outlook verification client-ready`: one explicitly `clientReported: true` sample
  after React commit and two animation frames. This is a paint opportunity, not
  proof that a human saw the page. Reported durations are bounded and untrusted.

Important summary fields: serverTotalMs, bootstrapMs, workerMs, workflowStartupMs,
workflowGapMs, graphDurationMs, databaseMs, persistenceMs, credentialMs,
tokenRefreshMs, authorizationMs, creditEntitlementMs, headerNormalizationMs,
decryptDeserializeMs, encryptSerializeMs, safetyEvaluationMs, wallResidualMs.
The summary also reports verificationBatchesPerStep and verificationStepBudgetMs.
Stages also cover request receipt, session resolution, scoped purge, report retrieval,
candidate building, job creation, safety context, participation, aggregation, response
generation, repository reads/writes and provider request coordination.

For wall-time reconciliation use:

`serverTotalMs ~= bootstrapMs + workflowStartupMs + workflowGapMs + workerMs + wallResidualMs`

Do not sum nested spans. Graph call time includes its coordination and normalization;
job persistence includes repository reads, decode, encode and transaction writes;
authorization includes entitlement time. `databaseMs` measures the instrumented
repository/connection/fence await spans, not every underlying SQL statement. Purge
and billing/reconciliation have their own inclusive spans. Parallel coordination
operations and nested database time are not an exclusive critical-path budget.
Step-gap/startup estimates use server wall timestamps across executions; a large
signed residual indicates clock/measurement differences and must not be hidden.

Client fields separate startRequestMs (click through acceptance/body parsing),
pollRequests, pollHttpMs (status request/body parsing), pollingAndWaitMs (remaining
acceptance-to-ready wait, including backend work), renderAfterReadyResponseMs,
and clientTotalMs. Browser durations use only `performance.now`, preserving the
clock-skew fix. `readyCheckpointToVisibleUpperBoundMs` includes age since the job's
last updatedAt, the full last status round trip, and local rendering. It deliberately
overestimates backend-ready-to-render delay: updatedAt precedes final persistence
commit. Read the final persistence span alongside it; do not call it exact latency.

## Next production test

1. Deploy this revision; no env or production-gate changes are required. Verify the
   build/revision. Use the same Outlook inbox with a valid current report; rescan
   only if its existing expiry rules require it.
2. If the earlier unconfirmed ready selection is still loaded, use Change selection
   and wait for its authoritative successful discard. Never discard mutation/recovery
   work. This avoids benchmarking reused acceptance.
3. Select only the same sender group (about 1,379 potential messages), choose All
   recommended (or a displayed relative amount), open browser Network, and click Check once. Keep the tab
   visible and do not navigate/reload or start other scans/checks.
4. Note the random X-Outlook-Verification-Id response header on the start POST.
   Wait for the ready review/confirmation panel. **Do not confirm moving messages.**
   Verify one successful `/api/app/cleanup/verification-timing` POST (204). If blocked
   or interrupted, the server trace still works but browser latency is unproven.
5. Filter Vercel logs by this correlationId. Collect the start/status/worker timing
   records, existing complete metrics, end-to-end summary and client-ready sample.
   Check `reused: false`, the actual requested amount, approved/checked/excluded, steps, retries and
   actual Graph batch count. Exclusions may legitimately increase candidates/steps.
6. Compare bootstrap, startup/gaps and worker costs first; then look at worker
   authorization/credentials, Graph, database/persistence and client-ready delay.
   Supply only these safe aggregate logs for the next optimization decision.

The instrumentation does not retroactively explain the earlier 60-second run. One
new full trace is required before identifying the missing ~25 seconds as DB,
Workflow, provider or frontend time. No raw mailbox values, IDs, Subjects, headers,
credentials, payloads or exceptions are logged. Client telemetry rejects unknown
fields and requires a same-origin authenticated request; it never changes job state.

## Files in this pass

```text
organizinbox-specs.md
docs/outlook-verification-timing.md
app/api/app/cleanup/[provider]/[action]/route.ts
app/api/app/cleanup/verification-timing/route.ts
src/components/product/GmailCleanupClient.tsx
src/lib/outlook-verification-client-timing.ts
src/lib/billing/cleanup-boundary.ts
src/lib/providers/microsoft/provider.ts
src/lib/server/outlook-verification-timing.ts
src/lib/server/gmail-scalable-cleanup-durable-store.ts
src/lib/server/live-scan-store.ts
src/lib/server/microsoft-connection.ts
src/lib/server/outlook-cleanup.ts
src/lib/server/production-cleanup.ts
src/lib/server/provider-cleanup-workflow-start.ts
src/lib/server/provider-request-coordinator.ts
src/lib/server/provider-work-fence.ts
src/lib/server/session.ts
src/workflows/provider-cleanup.ts
tests/cleanup-presentation-refresh.test.ts
tests/outlook-cleanup-recovery.test.ts
tests/outlook-verification-timing-route.test.ts
tests/outlook-verification-timing.test.ts
```
