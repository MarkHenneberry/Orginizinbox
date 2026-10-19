# Database usage and environment separation

Keep Prisma ORM and Prisma Postgres. These changes need no schema migration,
new runtime secret, production-feature change or paid scheduler.

## Request budgets

Estimates count Prisma model calls, not SQL statements or billed provider
operations. Transactions, relation loading, expired-state deletion and billing
reconciliation can cost more. Verify the operation counter after deployment.

| Path | Previous | Current |
| --- | --- | --- |
| Idle report/cleanup tab | 4 availability requests/minute; roughly 16-60+ calls/minute | Zero recurring requests/calls; SSR snapshot plus throttled focus/state-change refresh |
| Outlook availability, credits available | About 15 + K calls, K encrypted jobs | About 7, independent of K; one batched encrypted-state query |
| Gmail availability, credits available | About 14 calls | About 6 |
| Disabled-provider availability | About 3-4 + K | About 3-4, only on an actual refresh |
| Production cleanup status | About 7 | About 4; one authorization chain and one job-state read |
| Empty user-scoped purge | 7 | 3; no backlog/deferred counts |
| Financially unchanged confirmed checkpoint | CAS plus about 4 accounting calls | Same durable CAS; no redundant accounting calls |

Page-load savings depend on layout/page helper overlap. One RSC render now shares
session, current connection, app-home state, report loaders and UI entitlement
resolution using React `cache`. For example, two identical current-connection
resolutions cost one chain (~3 calls), not two (~6); repeated session reads share
their validation read too. There is no universal page-load percentage:
standalone loaders, purge, job recovery and stale billing can add work. API routes
and workers do not rely on React render caching for authorization. Mutation checks
remain fresh and authoritative.

Active status polling remains single-flight and adaptive (1/2/3 seconds), stops
at terminal state, pauses when hidden, and resumes on visibility/focus. Availability
has no timer: focus refreshes are throttled to five seconds; state changes coalesce.
Returning from connect, disconnect or Checkout gets a fresh server-rendered snapshot.

Job progress/dispatch CAS writes remain durable. Reservation creation, changed
verified counts and closure still execute accounting in the same serializable
transaction. Identical requested/moved/restored/closed tuples skip only redundant
financial work; existing no-refund-on-Undo semantics remain unchanged.

Contention uses exponential jittered backoff, not a new authorization cache.
Request coordination retains the roughly 12-second wait budget and all fences;
token refresh can wait 35 seconds for the existing 30-second lease. Observing a
live refresh lease skips a doomed claim UPDATE. Lost versions/leases still fail closed.

## Manual environment setup

Prisma meters the allowance across **every project and database in one workspace**,
not separately per database. Separate environment databases in that workspace protect
data but do not protect Production's operation quota. This is stated in the official
[Free-plan documentation](https://www.prisma.io/docs/full-stack-tutorial).

Lowest-cost recommendation: keep the existing Production database/workspace, use
local Postgres for Development and a separate disposable local/CI Postgres database
for integration tests, and skip database-backed Preview deployment/testing unless
needed. Prisma ORM works with local Postgres without a Prisma-hosted operation meter.
If remote Preview/staging is required, use a non-production database in a **different
workspace/billing quota**, subject to account eligibility and current plan limits,
or another isolated hosted test database. A separate project in the same workspace
does not suffice. No new paid plan is required by this code revision.

For a Preview without a database, do not supply Production DB credentials at all;
leave provider/cleanup flags off and restrict review to public/unavailable UI states.
Missing DB configuration does not make the authenticated app a fully functional demo.
Do not enable fixture mode in Production/Preview to work around production gates.

1. Vercel Project Settings > Environment Variables: scope the existing production
   `DATABASE_URL` to Production only. Do not change its credentials or target here.
2. Remove Production DB access from Preview/Development scopes, branch overrides,
   local env files and CI. For DB-backed Previews only, set `DATABASE_URL` to a
   separate-quota non-production target. Use local Postgres for Development.
3. Set local/CI `TEST_DATABASE_URL` to a separate disposable local/CI Postgres
   database for `npm run test:postgres` and `npm run test:workflow-fixtures`. Apply
   existing migrations to that database deliberately, outside these test commands.
4. The harness fails before connection when the test URL is absent, malformed or
   matches the application database (including known direct/pool aliases). URL
   checks cannot establish ownership of a different hostname: manually ensure no
   Production credential/alias is used. Ordinary `npm test` uses mocks, apart from
   the explicitly opt-in live Gmail proof, which must remain disabled for this pass.
5. Redeploy after environment-scope changes. Do not run tests by pulling Production
   secrets into local env. Different databases/projects in the same Prisma workspace
   still share its allowance; a new project is not a quota-isolation boundary.

## Safe observability

Production logs emit `Organizinbox database activity` with only a fixed route name,
status, event and duration. Count `cleanup_availability`, `cleanup_status`,
`cleanup_action`, `gmail_scan_status`, `outlook_scan_status` events by time window.
These are route counters, not query counters. No telemetry database writes occur.
Development-only browser debug events identify polling start/stop/hidden/focus
without user/job data. Production does not expose those development diagnostics.
Use browser Network and Vercel request logs to investigate duplicate/background
requests; do not enable raw SQL/parameter or provider-body logging.

## User-controlled 24-hour restore validation

Deploy this revision before manually activating the one-time restore. Do not run
DB integration or Workflow fixture suites against Production during this window.
First verify the deployed revision/build and public routes while DB access remains
blocked; authenticated/provider validation necessarily follows restoration.

1. Record the Prisma operation counter and UTC time; open one authenticated report
   tab. After the initial render, leave it idle for 15 minutes. Network must show no
   recurring availability/status calls. Repeat with a hidden tab and two idle tabs.
   Account for unrelated users and the daily cron when comparing global counters.
2. Focus a tab repeatedly: at most one availability refresh per five seconds unless
   a real state-change event occurs. Check Gmail and Outlook separately, cleanup
   disabled, no credits and with credits. Never enable cleanup just for this test.
3. Run one read-only scan per provider. Check visible progress, hide the tab (polls
   pause), return (progress catches up), then completion (polling stops). Reload and
   reattach to confirm durable progress and duplicate-start protection.
4. On Account/Credits, confirm linked-inbox shared balance, expired reservations
   released after eligible purge, and existing billing actions. Use Stripe test mode
   in isolated staging for purchase/webhook/reconcile testing; no live charges needed.
5. Only where cleanup is already deliberately enabled and authorized, manually use
   the smallest supported proof size. Check confirm, progress, completion, exact Undo
   or Recovery Undo, no double credit debit on re-entry, and no credit refund on Undo.
   Otherwise run these in isolated staging; preserve production flags.
6. Record counter deltas per action with other tabs idle. Compare request counts
   with the budgets above. Check safe event volume, terminal polling cessation,
   disconnect fencing and recovery after reload. Track the daily cron separately.
7. Review total genuine activity before deciding whether the current plan is viable.
   No application optimization can guarantee a monthly quota under growth.

Concerning: continuing availability/status requests from settled idle tabs, repeated
requests from hidden tabs, polling after a terminal response, or a rising sustained
counter slope after all work finishes (allow for reporting lag and the daily sweep).
Investigate unexplained hundreds/thousands of idle operations per hour. The current
200,000/month allowance averages roughly 6,667/day over 30 days; use measured normal
activity, not this one-off proof day's total, to project monthly demand and leave
headroom. A restored workspace is already above quota: the 24-hour grace period
does not reset its monthly allowance; access may stop again when it ends unless the
month has reset or the plan changes. See the official
[quota/restoration FAQ](https://www.prisma.io/docs/postgres/faq).

## Change manifest

Updated:

```text
.env.example
README.md
organizinbox-specs.md
docs/postgres-recovery-proof.md
docs/production-configuration.md
app/api/app/cleanup/[provider]/[action]/route.ts
app/api/app/cleanup/availability/route.ts
app/api/app/gmail-scan/status/route.ts
app/api/app/microsoft-scan/status/route.ts
src/components/product/BillingActions.tsx
src/components/product/GmailCleanupClient.tsx
src/components/product/GmailScanClient.tsx
src/components/product/useCleanupAvailability.ts
src/lib/adaptive-polling.ts
src/lib/billing/cleanup-boundary.ts
src/lib/billing/credits.ts
src/lib/billing/entitlements.ts
src/lib/server/app-state.ts
src/lib/server/cleanup-job-store.ts
src/lib/server/gmail-scalable-cleanup-durable-store.ts
src/lib/server/gmail-scalable-cleanup-runner.ts
src/lib/server/outlook-cleanup-store.ts
src/lib/server/outlook-cleanup.ts
src/lib/server/production-cleanup-ui.ts
src/lib/server/provider-connection-state.ts
src/lib/server/provider-request-coordinator.ts
src/lib/server/provider-token-refresh.ts
src/lib/server/report-state.ts
src/lib/server/session.ts
src/lib/server/transient-state-purge.ts
tests/gmail-scalable-durable-store.test.ts
tests/outlook-cleanup-selection.test.ts
tests/production-cleanup-rollout.test.ts
tests/production-cleanup-ui-state.test.ts
tests/progress-performance.test.ts
tests/provider-concurrency.test.ts
tests/transient-state-retention.test.ts
vitest.postgres.config.ts
vitest.workflow.config.ts
```

Added:

```text
docs/database-usage.md
scripts/test-database-config.ts
src/lib/cleanup-availability-events.ts
src/lib/server/contention-backoff.ts
src/lib/server/database-usage.ts
tests/cleanup-credit-checkpoints.test.ts
tests/database-environment.test.ts
tests/database-usage.test.ts
tests/entitlement-query-budget.test.ts
```
