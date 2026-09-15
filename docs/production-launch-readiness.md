# Production Launch Readiness

Code review: 2026-09-10. This is a deployment checklist, not proof that deployed services are healthy. No provider calls, database changes or production enablement were performed in this pass.

## Rollout Boundary

- Production cleanup authorization now uses independent default-off provider flags and an operation-aware recovery gate. See `production-cleanup-rollout.md` for the current policy; the earlier hardcoded-stop review is superseded.
- Development cleanup routes retain their independent production rejection. Proof, Undo, diagnostic and benchmark routes are not promoted to production. A separate production API reuses the durable services; the report/cleanup page still does not offer production cleanup in this gate-only pass.
- Provider availability flags permit OAuth and read-only scans only. Scans and scan workers independently enforce availability. Missing required shared config disables both providers; missing OAuth config disables its provider.
- The production boundary combines entitlement, provider availability, durable job/connection authorization and explicit infrastructure configuration. Deployed execution and the customer-facing UI rollout still need staging sign-off. No flags have been enabled.
- Keep `STRIPE_BILLING_ENABLED=false` while the paid cleanup service is unavailable. Billing configuration can be staged without selling access to a disabled service.

## Configuration And Deployment

Set secrets in the deployment's server environment, not source control or client-exposed variables. Do not copy local fixture settings into production.

| Area | Required configuration/check |
| --- | --- |
| Runtime | Production build with `NODE_ENV=production`; `NEXT_PUBLIC_APP_URL` is the canonical HTTPS origin. |
| Database | `DATABASE_URL` for the existing PostgreSQL database. Apply committed Prisma migrations with `npx prisma migrate deploy`, verify `npx prisma migrate status`, and generate the native client with `npm run prisma:generate`. Do not generate an engine-less/Accelerate-only client for a direct PostgreSQL URL. Check connectivity and pool limits from the deployed runtime. |
| Encryption | Independent `TOKEN_ENCRYPTION_KEY` and `CLEANUP_STATE_ENCRYPTION_KEY`: each exactly 32 bytes, encoded as supported by the existing crypto helper. Keep stable across instances/deployments; replacing keys without a rotation plan breaks existing sessions/state. |
| Gmail | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=<origin>/api/oauth/google/callback`; production consent/verification and the existing approved scopes. `GMAIL_IMAP_HOST=imap.gmail.com`, `GMAIL_IMAP_PORT=993` defaults. |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI=<origin>/api/oauth/microsoft/callback`; valid `MICROSOFT_TENANT_ID` (`common` by default), matching account types and existing approved scopes. No scope changes in this pass. |
| Availability | `GMAIL_PRODUCTION_ENABLED=false`, `MICROSOFT_PRODUCTION_ENABLED=false` until that provider's deployment checks pass. Explicit `true` enables only connection/read-only scanning. |
| Workflow | `next.config.ts` must retain `withWorkflow`. Deploy the compiled Workflow integration and verify execution/re-entry. `CLEANUP_WORKFLOW_ENABLED` is the default-off production cleanup infrastructure switch, not a health probe; it must remain enabled through outstanding Undo deadlines. `GMAIL_SCALABLE_WORKFLOW_ENABLED` remains development-only. |
| Retention Cron | Strong server-only `CRON_SECRET`. Deploy the existing `vercel.json` minute schedule for `/api/cron/purge-transient-state` on a plan supporting it; confirm authenticated scheduled execution, not merely a manual invocation. Missing secret refuses purge; absent/misconfigured scheduler must block operational sign-off. |
| Retention values | Preserve configured `CLEANUP_STATE_ACTIVE_TTL_SECONDS`, `CLEANUP_STATE_UNDO_TTL_SECONDS`, `CLEANUP_STATE_TERMINAL_TTL_SECONDS`, `CLEANUP_STATE_LOCK_TTL_SECONDS` (defaults 1800/1800/60/60). Scan state has a fixed one-hour TTL. Purge every minute is physical deletion cadence, not additional Undo time. |
| Stripe | `STRIPE_BILLING_MODE=test` for staging, `live` only for a reviewed live billing rollout; matching `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUBSCRIPTION_PRICE_ID`, plus DB, HTTPS app origin and session encryption. Keep `STRIPE_BILLING_ENABLED=false` for this release. Missing/invalid config disables billing and paid access; it need not disable free read-only scanning. |
| Development | Set `ORGANIZINBOX_FIXTURE_MODE=false` and all proof/benchmark/cleanup development flags false. Production independently forces these off even if set incorrectly. Only the separate production cleanup flags can authorize the production cleanup API. |

Configure the Stripe webhook at `<origin>/api/webhooks/stripe` with the matching signing secret and these existing events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Configure Customer Portal in the same Stripe mode. Validate signatures, replay, late delivery, cancelled period-end access and failed reconciliation in Stripe test mode before enabling checkout. Account's Refresh billing status action is the bounded reconciliation path; stale paid state is not blindly trusted.

## Failure Handling Reviewed

- Scan acceptance/Workflow scheduling failures now return HTTP 503 with safe retry wording and `SCAN_START_UNAVAILABLE`. Existing atomic acceptance reuses the scan when the user retries. No mutation, classifier or scheduling algorithm changed.
- Unknown connection/session failures return safe HTTP 503 `CONNECTION_UNAVAILABLE`; absent sessions/connections still return 401. Gmail no longer returns raw exceptions from scan-start. Outlook no longer labels scheduling failure as a mandatory reconnect.
- Provider scan outages/rate limits retain bounded retries and a terminal failure when exhausted. Production progress strips raw/internal diagnostic errors. The UI shows failure/retry rather than a completed report. Individual provider retry/throttle counts are not exported as production operational events today.
- Gmail cleanup confirmation already supports re-dispatch of the same accepted job after scheduling failure, with CAS/dispatch-intent protection. Production cleanup remains blocked. This pass did not change the mutation/recovery model.
- Invalid Stripe signatures return 400 before processing; processing/verification outages return sanitized 503. Entitlements fail closed; cancellation grants access only until the paid period ends. Billing errors link to Account.
- Undo uses the existing state deadline and server eligibility. Expired/missing restoration state cannot authorize Undo. Disconnect cancels/invalidates provider-scoped work and removes restoration state; already in-flight provider operations cannot be recalled. No changes to these behaviors.

## Required Alerts

Configure these in the production log/metrics destination before sign-off. Thresholds below are initial operational settings, not claims of an existing alert deployment. Alert payloads must include only component, allowlisted event/provider, time window and aggregate counts.

| Signal | Initial alert condition |
| --- | --- |
| `{component:"scan", event:"scan_start_failed"}` | Any occurrence: warning and investigate acceptance/Workflow delivery. At least 3 in 5 minutes: page. |
| `{component:"scan", event:"scan_connection_failed"}` | At least 3 in 5 minutes per provider: investigate DB, token refresh, configuration or provider outage. No raw exceptions are logged. |
| `{component:"billing", event:"checkout_failed"}` | At least 3 in 5 minutes when checkout is intentionally enabled. |
| Billing `webhook_processing_failed` or `reconciliation_failed` | Any occurrence: warning; at least 3 in 5 minutes: page. Also alert on Stripe webhook delivery exhaustion in Stripe. |
| Billing `webhook_signature_failed` | At least 5 in 5 minutes; verify signing-secret/mode configuration versus hostile traffic. Never log the signature/body. |
| Billing `reconciliation_required` without `reconciliation_succeeded` | Sustained failures for 10 minutes require investigation. Events have no user IDs, so this is an aggregate trend, not per-user correlation. An isolated stale snapshot is normal. |
| Billing `entitlement_denied` | Trend/count only by default (free/expired users are expected); alert on a sudden sustained spike after deployment rather than every denial. |
| `transient_state_purge` | Any `status=failed`, or no successful event for 3 minutes: page. `scans.remaining` or `cleanup.remaining` above zero for 5 consecutive runs: backlog warning. Track `deferred` counts without treating a live lease as a deletion failure. |
| Deployed Workflow | Alert on failed/exhausted runs, timeouts and delivery backlog. Export only workflow name/status/count; suppress step arguments/results and job/run/user identifiers in notifications. Confirm the monitor can see failures before any provider enablement. |
| Durable state health | An aggregate DB monitor should count pending/running ScanState rows with expired ownership or expired state; any count persisting for 15 minutes is a warning. Count failed Scan rows by provider over a rolling 15-minute window; at least 5 failures and over 20% of completed/failed scans is an outage warning. No row IDs or decrypted payloads in exports. This monitor still needs deployment wiring. |
| Platform/DB | Alert on function timeouts/OOM, pool exhaustion or unavailable DB; sustained API 5xx above 5% for 5 minutes (minimum 20 requests). Use route templates only, not full URLs. |

Application billing logs accept only allowlisted event names, scan-start logs only fixed categories/provider, and purge emits aggregate counts. IMAP raw logging is disabled. Production copyable diagnostics remain blocked. Platform/access logs and third-party drains need independent redaction: suppress authorization/cookie headers, OAuth callback query strings/codes, request/response bodies, SQL parameters, tokens and payment data. Do not enable provider SDK wire logging or capture decrypted Workflow state for debugging.

There is no production 429-specific event stream today; do not claim a throttle alert exists based on hidden development diagnostics. Use aggregate failure/latency monitoring initially, and add an explicitly privacy-reviewed aggregate provider metric before relying on throttle-specific alerts at scale.

## Manual Sign-Off

1. Review/apply the existing migrations to the intended database, generate/build/deploy, verify server env configuration and database connectivity without logging values. No schema changes were added by this pass.
2. Verify compiled Workflow dispatch/re-entry and actual scheduled Cron runs on the production-style deployment. Prove deletion of isolated expired fixture state and preservation of live state. Keep all provider and checkout flags off during setup.
3. Install alerts/redaction, test their notification paths with synthetic safe events, and confirm the Cron heartbeat monitor detects missing executions.
4. Use Stripe test-mode staging to exercise signature rejection, replay/out-of-order handling, missed-webhook reconciliation and paid/free/past-due/cancelled/expired states. Confirm production cleanup still refuses both providers even with active test entitlement.
5. Check production fixture/dev/IMAP/proof endpoints and pages cannot run; confirm disabled-provider maintenance, safe scan-start scheduling-failure/retry, expired Undo and disconnect fencing using isolated fixtures. No real mailbox mutation is needed for these checks.
6. Complete provider consent approvals and an owner-run read-only deployed scan smoke test before enabling each read-only provider flag. Keep paid checkout and production cleanup off. Production cleanup needs a separate explicit release review, not an environment change in this pass.
