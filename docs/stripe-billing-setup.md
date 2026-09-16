# One-time cleanup credit billing

Keep `STRIPE_BILLING_ENABLED=false`, `GMAIL_PRODUCTION_CLEANUP_ENABLED=false`
and `MICROSOFT_PRODUCTION_CLEANUP_ENABLED=false` until staging validation passes.
No real payment or mailbox operation was performed during implementation.

## Database

Review and apply `20260915120000_add_cleanup_credits` using `npx prisma migrate deploy`
against the intended database, then run `npm run prisma:generate`.
This migration has NOT been applied automatically. Prisma CLI reads `.env`, whereas
Next reads `.env.local` first; supply the correct connection securely without printing it.

The additive migration retains historical subscription/Purchase fields for operator
review. They no longer grant access or initiate recurring payments. Review existing
Stripe subscriptions separately: deploying this code does not cancel them, refund
them, or convert them to credits. Accounts with old subscription references cannot
start a credit purchase until reconciled by an operator.

Financial records contain only internal account/job references, Stripe references,
pack amounts and aggregate credit counts, never mailbox IDs or metadata. There is
no expiry on the account balance. The purchase's `expiresAt` is the Checkout session
deadline, not a credit expiry. Financial rows survive transient mailbox-state deletion.

The migration includes a partial unique index allowing one pending purchase per
account and aggregate count CHECK constraints; retain these in future migrations.
CleanupJobState deletion uses a foreign key SET NULL to release unused reservations
atomically, including Cron/disconnect/cascade deletion. It does not refund spent credits.

## Stripe Dashboard and environment

1. Use Stripe sandbox/test mode first. Create one Organizinbox cleanup-credit product
   with three USD, one-time, per-unit prices (quantity one):
   - $10.00 / 10,000 credits: `STRIPE_PRICE_10000_CREDITS`.
   - $15.00 / 50,000 credits: `STRIPE_PRICE_50000_CREDITS`.
   - $20.00 / 100,000 credits: `STRIPE_PRICE_100000_CREDITS`.
2. Configure server-only `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_BILLING_MODE=test`, and all three price IDs. Retain the existing
   `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, and exact `NEXT_PUBLIC_APP_URL` origin.
   Production requires HTTPS. No publishable key or Customer Portal is needed.
3. Create a snapshot webhook destination for your account at
   `https://YOUR-HOST/api/webhooks/stripe`, version `2026-08-26.dahlia`, with:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`.
4. Do not add subscriptions, trials, promotions, adjustable quantities, or saved
   off-session payments. This implementation validates the exact USD total and
   rejects discounts or added tax; review applicable tax requirements before sales.
5. Enable `STRIPE_BILLING_ENABLED=true` only in controlled staging. Keep cleanup OFF.
   Test/live keys, price IDs, customer records and signing secret must match.

## Staging acceptance

- Authenticate an inbox, purchase the small pack with a Stripe test card, and confirm
  Account shows 10,000 credits. The browser return URL alone must not grant credits.
- Replay the same event and deliver a second event for the same payment. Balance
  stays 10,000. Buy another pack; balances accumulate.
- Interrupt Checkout creation after Stripe receives it. Retry the same pack; it
  must reuse the persisted purchase/idempotency key, not charge again. An unknown
  attempt older than 23 hours requires operator reconciliation, never blind replay.
- Delay webhooks and use Check payment status. Account/access reads reconcile when
  older than five minutes; explicit refresh uses a one-minute window. Reconciliation
  examines at most 20 purchases, rotating oldest checked first; large histories may
  require multiple passes. Failed reconciliation retains a two-minute lease cooldown.
- Refund all/part of a test purchase and replay old paid events. Reversed credits
  must not reappear. Disputes block the entire purchase; a won dispute needs explicit
  operator review before restoring credits. Spent refunded credits can make balance
  negative and block new work, without blocking verified Undo.
- From Account, confirm Link another inbox and authenticate a different Gmail/Outlook
  identity. Confirm the same credit balance and a separate mailbox report. Reconnect
  either linked inbox normally; repeat purchases must reach the shared account.
- Attempt an expired/replayed/wrong-provider link, disconnect the source during
  linking, and race target Checkout against linking. No unauthorized sharing or
  orphaned payments may occur. Separately funded accounts cannot be merged here.
- Test the real PostgreSQL financial transaction and FK constraints with isolated
  fixtures after applying the migration. Automated unit tests are not a replacement
  for these database race tests.
- With mocked provider transports, reserve 500, verify 450 moves and leave 50
  excluded/failed/uncertain: spend 450. Verify 400 restores: refund 400, once.
  Replace the worker and replay every save. Counts and balance must remain stable.
- Test concurrent jobs across linked Gmail/Outlook identities competing for one
  balance. Reservations must prevent overspending. Expire/delete transient state:
  release unused holds but retain spent-credit and purchase history.
- Only after separate authorization, validate small disposable-inbox cleanup/Undo
  in staging. Never use real customer inboxes for acceptance testing. Keep production
  cleanup flags OFF throughout this implementation pass.

Monitor aggregate billing events (`checkout_failed`, `webhook_signature_failed`,
`webhook_processing_failed`, `reconciliation_required`, `reconciliation_failed`,
`reconciliation_succeeded`, `entitlement_denied`) plus Stripe failed deliveries.
No payment details, account IDs, mailbox data or raw exception content in these logs.

References: [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment),
[webhooks](https://docs.stripe.com/webhooks),
[idempotent requests](https://docs.stripe.com/api/idempotent_requests).
