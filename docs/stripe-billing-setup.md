# Stripe billing setup

This foundation does not enable production cleanup. Keep new subscriptions off
until the product is ready to sell. No Stripe or mailbox API requests were made
during implementation; automated tests use local signatures and mocked Stripe.

## Database and deployment

- Apply `20260909120000_add_billing_entitlements` with `npx prisma migrate deploy`
  in the deployment environment, with the intended `DATABASE_URL` already set.
  The migration adds `BillingAccount` and `StripeWebhookReceipt`; it does not
  replace the database or modify mailbox tables.
- Run `npm run prisma:generate` when installing/building the deployment.
- Local Next.js loads `.env.local` before `.env`. Prisma CLI alone loads `.env`;
  ensure its process receives the intended database URL before migration commands.
  Never paste or log credentials. The implementation's status check used Next's
  environment loader and found only this new migration pending; it was not applied.

## Server configuration

| Variable | Value |
| --- | --- |
| `STRIPE_BILLING_ENABLED` | `false` by default. `true` allows new Checkout sessions only. |
| `STRIPE_BILLING_MODE` | `test` for sandbox/test; explicitly `live` for production live billing. |
| `STRIPE_SECRET_KEY` | Matching server-only `sk_test_...` or `sk_live_...`. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret `whsec_...` for this environment's endpoint. |
| `STRIPE_SUBSCRIPTION_PRICE_ID` | One matching-environment recurring `price_...`. |
| `NEXT_PUBLIC_APP_URL` | Exact application origin, HTTPS in production, no path/query. Local test mode permits HTTP localhost. |
| `DATABASE_URL` | Existing Prisma/Postgres database with the billing migration applied. |
| `TOKEN_ENCRYPTION_KEY` | Existing valid 32-byte server key used for authenticated sessions; required in production. |

No publishable Stripe key is needed for hosted Checkout/Portal. Never prefix Stripe
secrets or flags with `NEXT_PUBLIC_`. Live keys are rejected outside production.
Missing/invalid configuration disables billing. Turning off new subscriptions
does not block Portal or signed webhook processing for existing customers.
Do not change keys or the configured price of existing subscribers without a
migration plan: mode/price mismatches deny entitlement.

## Stripe Dashboard

1. Start in a Stripe sandbox/test environment. Create one Organizinbox product
   with one recurring, flat-rate price, quantity one. Choose the amount and interval
   explicitly; the old one-time $9.99 hypothesis is not a subscription price.
   Do not configure trials, usage tiers, quantity changes, or additional plans.
2. Copy that price ID and the matching server secret key into the environment
   through secure deployment settings. Set mode `test` initially.
3. Configure the default Customer Portal: allow payment-method updates, invoice
   history and cancellation at period end. Disable subscription switching and
   quantity changes. The app creates authenticated, customer-specific Portal sessions.
4. In Workbench > Webhooks, create an event destination for **Your account**, using
   snapshot events and API version **2026-08-26.dahlia** (Stripe SDK 22.6.1).
   Choose Webhook endpoint and enter
   `https://YOUR-APP-HOST/api/webhooks/stripe`.
5. Select exactly these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
6. Store the endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`. Do not use a
   sandbox endpoint secret for live billing. A Stripe CLI forwarding secret is
   separate from a Dashboard endpoint secret.
7. For controlled testing, enable new subscriptions, sign in to Organizinbox, open
   Account > Billing, and use Start subscription with Stripe test payment details.
   Confirm that webhook delivery, not the return URL, updates paid access.
8. Test duplicate webhook delivery, declined payments, renewal, period-end
   cancellation, immediate cancellation, and Portal access. Verify expiry denies
   access at the paid period boundary. Watch failed webhook deliveries in Stripe;
   a 503 intentionally asks Stripe to retry. Do not log webhook bodies or secrets.
9. Before any live sales, repeat product/price, Portal and webhook configuration
   in live mode. Set live server credentials and mode only on the production
   deployment. Keep `STRIPE_BILLING_ENABLED=false` until paid cleanup is actually
   ready. Paid status alone still cannot enable any production cleanup route.

## Ownership and recovery

One billing account belongs to one authenticated Organizinbox user, with unique
Stripe customer/subscription mappings. No email or webhook metadata links users.
Only Stripe IDs, subscription status/period, concurrency fields and event receipts
are stored; raw webhook bodies, card data and mailbox metadata are not stored.
Signed events reconcile the current subscription with Stripe under a per-user
lease. The entitlement update and unique event receipt commit atomically; failures
remain retryable. Delayed events do not blindly overwrite state with old payloads.

Checkout uses a durable idempotency key and reuses open sessions. Unknown attempts
older than 23 hours fail closed for manual reconciliation rather than risking a
duplicate purchase after Stripe's idempotency retention window. If a process dies,
its 120-second lease expires. An operator must inspect Stripe before clearing an
unresolved checkout attempt. Multiple non-terminal subscriptions or more than 100
historical subscriptions require support review rather than guessing access.

Paid access requires the configured price/mode, active subscription, a paid latest
invoice and an unexpired period. Cancellation at period end retains access only
through that boundary. Past due, inactive, trial or immediately cancelled states
do not grant access. Webhook outages can delay cancellation/payment updates;
monitor and replay failed deliveries before enabling paid cleanup. Refunds and
disputes need an explicit operating policy; they are not automatic entitlement
events in this MVP.

Billing currently uses the existing provider-backed sign-in. Disconnecting removes
the app session but does not cancel billing. Reconnect the same identity to manage
the subscription. A reliable account-access/support recovery procedure is required
before live sales, especially if the identity provider is unavailable.

The provider-neutral `productionCleanupBoundary` now enforces validated session
ownership and `requirePaidCleanupEntitlement` before Gmail legacy/scalable and
Outlook preview/start/confirmation routes in production. Development bypasses
billing, and Undo is not newly paywalled. Free/inactive users receive HTTP 402 with
an Account upgrade/manage action; unavailable verification returns 503. Paid users
still receive `CLEANUP_UNAVAILABLE`: `productionCleanupAvailable` is hard-disabled,
and the existing development route and worker production blocks remain intact.
No environment variable can enable production cleanup in this implementation.

## Bounded reconciliation

Account reads and production entitlement checks refresh mapped billing accounts
whose successful snapshot is at least five minutes old (or missing). The Account
Refresh billing status action posts to `/api/billing/reconcile`; it may refresh
after a one-minute minimum interval, including after Checkout/Portal returns.
Both use the same current-Stripe-state projection as webhooks. Free accounts with
no customer require no Stripe request. Period expiry is checked on every access,
even inside the freshness window.

Each refresh is one subscription-list page, capped at 100 subscriptions, with an
eight-second SDK request timeout and at most one network retry. Existing database
leases serialize it with Checkout/webhooks. Failures preserve the two-minute lease
as a durable cooldown across processes; later attempts fail closed without more
Stripe requests until expiry. Old lease holders cannot publish results. Stale data
is never used as an access fallback. Portal remains accessible on Account when
reconciliation fails. No background sweep/cron or additional schema is required.

## Staging validation for cleanup billing gates

1. Use an HTTPS staging deployment running the production build with Stripe test
   credentials/mode and the existing billing migration applied. Configure the six
   webhook events above. Enable new subscriptions only in this controlled test
   environment. Do not enable or bypass any cleanup production block.
2. Sign in as an unpaid staging user. Account should show free access and Upgrade
   (when new subscriptions are enabled). Using a same-origin authenticated browser
   POST, call `/api/dev/gmail-scalable-cleanup/start` and
   `/api/dev/outlook-cleanup/start` with JSON `{}`. Both must return 402,
   `PAID_ACCESS_REQUIRED`, and `/app/account`, before any cleanup service runs.
   Client fields such as `paidAccess:true` or another user ID must not change this.
3. Complete a sandbox subscription. Return to Account. If the webhook has not
   updated access, wait at least one minute after the last billing check and select
   Refresh billing status. Confirm active paid status and Manage billing appear.
   Repeat both POSTs: expect 503 `CLEANUP_UNAVAILABLE`, never an accepted job.
4. Temporarily disable delivery to this staging webhook destination (not the
   Stripe API key). Cancel the test subscription immediately in Stripe. After
   five minutes, reload Account, or after one minute use Refresh billing status.
   Verify paid access is revoked and both cleanup POSTs return 402. Re-enable
   delivery and resend an older paid event twice: access must remain inactive.
5. Test cancellation at period end on another sandbox subscription: access stays
   active before the paid boundary and becomes inactive at it. Exercise past-due
   status with a failing sandbox renewal (Stripe test clocks may be used in a
   dedicated test setup); verify Manage billing and 402 denial. A later successful
   payment plus reconciliation should restore paid status, but not enable cleanup.
6. In staging only, simulate Stripe API failure using a controlled fault-injection
   proxy or sandbox credential revocation, without affecting live credentials.
   Trigger a stale refresh. Expect generic 503, unverified Account status, no stale
   grant, and the `reconciliation_failed` event. Retry during the next two minutes:
   no new reconciliation call should reach Stripe. Restore connectivity and retry
   after the lease expires; status should recover. Do not clear leases manually.
7. Trigger concurrent refreshes in two signed-in tabs after the freshness window.
   Expect one reconciliation owner; the other can return retryable unavailable.
   Reload after completion. Restart/replace the process during a staged failed
   attempt and verify the database cooldown still applies.
8. Send an invalid signature to the staging webhook: expect 400 and
   `webhook_signature_failed`, with no payload/signature in logs. Use Workbench
   Event deliveries to resend a valid event twice and verify receipt idempotency.
   Re-enable webhook delivery, restore test configuration and disable new sales
   after the controlled test. No mailbox mutation is needed for any of these steps.

## Operational monitoring and launch conditions

Filter runtime JSON logs by `component=billing`. Configure alerts for sustained
`checkout_failed`, `webhook_signature_failed`, `webhook_processing_failed`,
`reconciliation_failed`, and unusual `entitlement_denied` counts. Track
`reconciliation_required` versus `reconciliation_succeeded` to detect recovery
problems. These events have fixed names only: no exception text, user/Stripe IDs,
payment details, signatures, URLs, secrets or mailbox data. Alert destinations and
thresholds require deployment-operator setup; no external monitors were provisioned.
Keep Stripe webhook delivery alerts enabled and replay failed deliveries there.

Before enabling production cleanup: pass the staging matrix, configure monitoring,
resolve account-access recovery and refund/dispute policy, and separately review
production cleanup rollout and worker/provider gates. Entitlement is already wired
at acceptance/confirmation, but it is not an authorization substitute for durable
job ownership, connection fencing, or safe mutation/recovery. The remaining missed-
webhook consistency window is up to five minutes; inactive users with no access
are reconciled on their next Account/access request, not by a background scheduler.

References: https://docs.stripe.com/webhooks,
https://docs.stripe.com/api/idempotent_requests,
https://docs.stripe.com/customer-management/configure-portal
