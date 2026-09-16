# Production Cleanup Gate Review

No production environment, secret, classifier, mutation algorithm, billing policy or OAuth scope was changed. The shared Review Cleanup UI uses server-resolved provider availability and paid access. New actions stay hidden when unavailable; existing-job status and eligible Undo remain reachable independently of report expiry. All production cleanup flags remain default-off; deployment and staging validation are still required before a public launch.

## Gate Model

- Start/confirm: production build, same-origin POST, validated session, provider availability, durable Prisma adapter, valid DB/encryption/OAuth/Cron configuration, `CLEANUP_WORKFLOW_ENABLED=true`, the provider's cleanup flag, active server-verified paid access, and an active owning connection with existing scopes and encrypted access/refresh credentials.
- Confirmation additionally requires an exact owned, non-cancelled job with unexpired transient state. Existing durable services retain their fresh-report, frozen-target, safety, CAS and dispatch-intent checks.
- Status/Undo: same session/origin/connection/infrastructure/job-ownership checks, but no new-cleanup flag, unspent-credit or Stripe-config dependency. Existing services alone determine exact verified-moved ledger eligibility, deadline and restore state. Uncertain targets are never admitted to Undo.
- Worker units enforce forward authorization again. Gmail verification and Undo steps use recovery authorization. Outlook checks forward authorization before a new unit; an already dispatched batch can finish verification without another move batch. Per-request ownership/lease/generation fencing remains in place.
- `/api/dev/**` stays blocked in production. Production does not expose fixture providers, proofs, classifier diagnostics, benchmark controls, IMAP controls or development diagnostic payloads. Gmail's legacy small cleanup service is not promoted to production.
- The Workflow switch is a configuration prerequisite, not a health probe. DB/state operations and Workflow dispatch still fail closed if the services are unavailable. Deployment verification is mandatory.

## Environment

New server-only flags, all default OFF (unset or any value other than `true` denies):

```dotenv
GMAIL_PRODUCTION_CLEANUP_ENABLED="false"
MICROSOFT_PRODUCTION_CLEANUP_ENABLED="false"
CLEANUP_WORKFLOW_ENABLED="false"
```

Forward Gmail additionally needs `GMAIL_PRODUCTION_ENABLED=true`; Outlook needs `MICROSOFT_PRODUCTION_ENABLED=true`. Provider availability validates `NEXT_PUBLIC_APP_URL`, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `CLEANUP_STATE_ENCRYPTION_KEY`, `CRON_SECRET`, and that provider's existing `GOOGLE_*` or `MICROSOFT_*` OAuth credentials/callback. Keep a valid Microsoft authority. The production adapter is Prisma, never memory.

Forward billing requires existing `STRIPE_BILLING_MODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_10000_CREDITS`, `STRIPE_PRICE_50000_CREDITS`, `STRIPE_PRICE_100000_CREDITS`, with a current matching paid entitlement. `STRIPE_BILLING_ENABLED` controls checkout, not existing entitlement or recovery. Keep checkout disabled until the paid service/UI is ready to deliver. No new pricing or scopes.

Keep the existing retention values and the deployed minute Cron unchanged. Do not rotate/remove keys or disconnect the provider to roll back cleanup.

## Production API

Same-origin authenticated POST only; provider is `gmail` or `microsoft`:

| Endpoint suffix under `/api/app/cleanup/<provider>/` | JSON body |
| --- | --- |
| `start` | `{ "groupIndices": [0], "requestedCount": 250 }` for Gmail; Outlook accepts 1-500. Gmail retains the proven durable 250/500 sizes only. Use eligible groups from the actual current report, not blindly index 0. |
| `confirm` | `{ "jobId": "<opaque job ID from start>", "confirmed": true }` |
| `status` | `{ "jobId": "<same opaque job ID>" }` |
| `undo` | `{ "jobId": "<same opaque job ID>", "confirmed": true }` |

Job IDs are opaque application control IDs, never mailbox IDs. Responses contain only ordinary aggregate progress, Undo availability/mode, status and the actual expiry. No provider identifiers, subjects, senders, folder IDs, raw errors, timing diagnostics or decrypted job state. Missing/expired ownership returns 410; invalid connection 401; inactive paid access 402; disabled/incomplete configuration 503. A scheduling/service error tells the caller to check status before retrying; the existing durable idempotency behavior remains authoritative.

## Rollback

1. Set only the affected `*_PRODUCTION_CLEANUP_ENABLED` flag to false and deploy. The other provider remains independently controlled.
2. Keep `CLEANUP_WORKFLOW_ENABLED=true`, provider production availability, DB, encryption, OAuth credentials and Cron operational. Do not erase credit accounting or require a new payment for recovery.
3. Confirm new start/confirm requests return 503. Confirm status and eligible Undo still work, including a zero credit balance or unavailable Stripe configuration.
4. Workflow runs are normally deployment-pinned. A redeploy does not rewrite an older worker's environment. Review/drain old forward runs; do not mistake this switch for an instant cross-deployment emergency kill. Already dispatched provider requests cannot be recalled. Never blindly retry an ambiguous move or interrupt verification expecting automatic reversal.
5. Use the current deployment's production Undo endpoint for each eligible existing job. Keep recovery infrastructure alive through all outstanding deadlines. Disconnect or expiry still makes restoration unavailable; the rollout flag does not reverse those security/retention boundaries.

## Staging Validation Before Enablement

1. Keep live production flags OFF. Apply existing migrations and deploy a production-style staging build with working Prisma, stable encryption, compiled Workflow and minute Cron. Use only isolated accounts/disposable test inboxes and Stripe test mode; no live charges.
2. Run `npm run test -- tests/production-cleanup-rollout.test.ts tests/outlook-cleanup-recovery.test.ts tests/cleanup-scheduling-recovery.test.ts tests/provider-work-recovery.test.ts tests/billing-cleanup-boundary.test.ts`. These use mocked provider/Stripe transports and do not contact mailboxes.
3. With both cleanup flags false, verify paid start/confirm is refused. With the staging Gmail flag true and Microsoft false, verify only Gmail can pass; repeat the inverse. Test missing DB/key/Cron/Workflow/OAuth config in a separate isolated deployment, not by removing keys from active recovery jobs. Verify zero-balance, fully reserved, refunded or mismatched-mode credit access is denied with flags true.
4. After explicitly authorizing a disposable-inbox test, perform a fresh scan, call `start` with exact Suggested group indices, wait for `ready` using `status`, inspect requested/approved/excluded counts, and only then POST `confirm`. Use Gmail's existing 250-message durable size or Outlook's smaller 5-message size for initial staging. This is a manual mutation test, not something the agent ran.
5. After verified moves, disable that provider's cleanup flag on the current staging deployment while keeping recovery infrastructure/provider availability active. New start/confirm must fail; `status` and confirmed `undo` must remain usable until expiry. Verify restored counts and inspect the disposable mailbox. Repeat with test entitlement inactive and with Stripe unavailable. Never Undo uncertain targets.
6. Exercise partial interruption and process replacement with mocked provider fixtures first. Verify known returned IDs can be checked, exact verified messages recover, uncertain messages stay unresolved, and no non-idempotent mutation is repeated. Check deployment-pinned old runs during rollback rather than assuming they inherit new env flags.
7. Verify every dev/proof/diagnostic endpoint remains denied even while the staging production cleanup flags are true. Inspect responses/log redaction and gate-denial UX. Public Review Cleanup UI/entry-point integration still requires a separate release before a customer-facing launch; do not treat passing API authorization tests as completing that UI rollout.
