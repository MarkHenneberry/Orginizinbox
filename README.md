# Organizinbox

Organizinbox is a discovery-first inbox cleanup microSaaS for large Gmail and Outlook inboxes. It helps users see what is causing clutter, review transparent cleanup recommendations, protect important mail, and move approved groups to Trash or Deleted Items.

## Local Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm audit --audit-level=high
```

## Environment Variables

Copy `.env.example` to `.env.local` for local work. Real secrets must never be committed.

- `NEXT_PUBLIC_APP_URL`: canonical site URL.
- `ORGANIZINBOX_FIXTURE_MODE`: keeps fixture report available locally.
- `DATABASE_URL`: PostgreSQL-compatible Prisma database for SaaS/account state.
- `TOKEN_ENCRYPTION_KEY`: required before persisting OAuth tokens.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`: Google OAuth for Gmail IMAP/XOAUTH2.
- `GMAIL_IMAP_HOST`, `GMAIL_IMAP_PORT`: Gmail IMAP endpoint configuration.
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI`: Microsoft OAuth for Graph.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FULL_RESET_USD`: Stripe checkout boundary.

## Development Fixture Mode

The fixture report uses deterministic fictional data to demonstrate a 38,217-message inbox. Visit:

```text
/app/report
```

No Gmail or Outlook account is connected in fixture mode, and cleanup buttons do not mutate a real mailbox. Fixture messages are generated in application code and processed through the streaming aggregator in bounded batches.

## Revised Scan Architecture

Gmail:

```text
Gmail
  -> IMAP/XOAUTH2
temporary scan worker
  -> streaming aggregation
  -> Inbox Report
```

Outlook:

```text
Outlook
  -> Graph/OAuth
temporary scan worker
  -> streaming aggregation
  -> Inbox Report
```

Next.js remains the product UI, marketing site, account surface, and API/control layer. Long-running scans should run behind a worker abstraction rather than inside ordinary short-lived request handlers.

## Privacy Model

Organizinbox should not become a mailbox database. Production mailbox records are transient processing data.

- Keep minimum mailbox-derived scan/report checkpoints and cleanup/Undo ledgers only in encrypted transient ScanState/CleanupJobState payloads, never normal Prisma columns or permanent reports.
- Discard Subject text after deriving protection signals; do not store or log it.
- Do not retrieve email bodies during normal scans.
- Do not download attachments.
- Do not send mailbox data to LLMs or external AI providers.
- Do not put mailbox metadata in analytics or logs.
- Do not sell mailbox-derived data, use it for advertising, train AI on it, or use it for unrelated profiling.
- Do not add permanent-delete capability.

Inbox Reports and required scan/cleanup state are stored temporarily in encrypted form, then removed after expiry; there is no permanent inbox copy.

### Scheduled Retention Deletion

`vercel.json` schedules `GET /api/cron/purge-transient-state` every minute in production. Configure a strong `CRON_SECRET` in Vercel Production before deploying; Vercel supplies it as a Bearer authorization header. Do not put it in a URL, browser bundle, or logs. Minute scheduling requires a supporting Vercel plan (not Hobby). Local development and preview deployments do not run this schedule automatically.

The purge uses stored `expiresAt`, not a new retention period. Scan/report state uses its existing one-hour window. Cleanup uses `CLEANUP_STATE_ACTIVE_TTL_SECONDS`, `CLEANUP_STATE_UNDO_TTL_SECONDS`, and `CLEANUP_STATE_TERMINAL_TTL_SECONDS` (defaults 1800/1800/60). Valid worker leases defer deletion. Each run removes at most 5,000 expired rows per table; subsequent runs drain any backlog. No provider request or decryption is involved. Normal aggregate Scan/CleanupJob records and provider credentials remain intact.

Monitor the aggregate-only `transient_state_purge` event, HTTP failures, missing scheduled invocations, remaining backlog and deferred counts. Vercel does not retry failed Cron invocations; the next sweep retries eligible rows. Deploy-time scheduling/authentication and backup retention require operational verification. Application row deletion does not erase backups or copies already delivered to a browser. Development memory adapters sweep idle expired entries while their process runs; the legacy scalable memory adapter defers potentially in-flight statuses until they finish or the process exits.

## Gmail OAuth / IMAP

The Gmail provider boundary is in `src/lib/providers/gmail`. The intended production direction is Google OAuth plus Gmail IMAP over TLS with XOAUTH2, using an explicit metadata allowlist.

Google may show broad Gmail permission language because IMAP access is broad. Organizinbox deliberately does not implement email sending, draft creation, full-message body reading, attachment downloading, permanent deletion, or mailbox expunge.

Real Gmail integration is not implemented yet.

## Microsoft Graph

The Microsoft provider boundary is in `src/lib/providers/microsoft`. The intended production direction is Microsoft OAuth plus Graph pagination with selected fields only.

Real Microsoft integration is not implemented yet.

## Stripe

Pricing configuration lives in `src/lib/config.ts`. Stripe checkout has a server-side boundary in `src/lib/billing/stripe.ts` and returns a configuration error until real keys and session creation are implemented.

## Architecture

- Provider capability firewall: `src/lib/providers/types.ts`
- Gmail processor boundary: `src/lib/providers/gmail/provider.ts`
- Microsoft processor boundary: `src/lib/providers/microsoft/provider.ts`
- Normalized transient record and domain types: `src/lib/domain/types.ts`
- Streaming report aggregation: `src/lib/domain/streaming-aggregator.ts`
- Classification, safety, and recommendations: `src/lib/domain`
- Worker orchestration boundary: `src/lib/scan/jobs.ts`
- Privacy-safe persistent scan record shape: `src/lib/persistence/scan-records.ts`
- Prisma SaaS/account model: `prisma/schema.prisma`

## Next Benchmark Pass

Before production Gmail integration is finalized, run an isolated Gmail IMAP performance spike for metadata-only scans against approximately:

- 5k messages
- 10k messages
- 25k messages
- 50k messages
- ideally 100k messages

Primary target: approximately 3-5 minutes for a 50k Gmail mailbox. This has not been validated yet and must not be claimed publicly until measured. If IMAP cannot meet the target, update `organizinbox-specs.md` before changing direction.
