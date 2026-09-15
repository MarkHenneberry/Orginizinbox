# Production Configuration

Provider flags enable connection and read-only scanning, not production cleanup.
Keep both flags false until deployment checks are complete. This pass does not
enable billing or promote development cleanup to production.

## Required Environment

Set these on the Vercel Production deployment, not with `NEXT_PUBLIC_` prefixes
(except the public application URL). Never commit real values.

| Purpose | Variables and requirements |
| --- | --- |
| Application | `NODE_ENV=production` (Next/Vercel sets this); `NEXT_PUBLIC_APP_URL` set to the actual HTTPS origin. |
| Database | `DATABASE_URL` pointing to the existing migrated PostgreSQL database. Direct `postgresql://` / `postgres://` URLs are supported; configured Prisma service URLs retain their existing client support. Do not replace the database or switch connection schemes to enable a provider. |
| Credentials and sessions | `TOKEN_ENCRYPTION_KEY`, exactly 32 bytes decoded from base64 or 32-byte UTF-8 material. This key also signs sessions. |
| Transient scans and cleanup | `CLEANUP_STATE_ENCRYPTION_KEY`, a separate strong 32-byte key in the same accepted formats. Do not rotate either key without a separate data/session rotation plan. |
| Retention scheduler | `CRON_SECRET`, a strong server-only secret. Deploy the existing `vercel.json` minute schedule for `/api/cron/purge-transient-state` on a plan supporting this frequency. A configured secret alone does not prove that Cron runs. |
| Gmail OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://<your-origin>/api/oauth/google/callback`, registered exactly with Google. Existing scopes and consent requirements are unchanged. |
| Microsoft OAuth | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI=https://<your-origin>/api/oauth/microsoft/callback`, registered exactly as a Web callback. `MICROSOFT_TENANT_ID` defaults to `common`; retain it for personal plus organizational accounts unless deliberately restricting the audience. Existing scopes are unchanged. |
| Production opt-ins | `GMAIL_PRODUCTION_ENABLED=true` and/or `MICROSOFT_PRODUCTION_ENABLED=true`. Missing, false or non-true values disable that provider. Credentials without an opt-in do not enable anything. |

Both providers require the shared database, HTTPS URL, encryption and Cron
configuration. Missing provider-specific OAuth configuration disables only that
provider. Configuration is validated locally, not by contacting a provider or DB.
Wrong credentials, missing migrations, unsupported plans and service outages still
require deployment verification.

## Scanning and Workflow

No benchmark or cleanup flags are needed for normal production scanning. Gmail
uses `GMAIL_IMAP_HOST=imap.gmail.com` and `GMAIL_IMAP_PORT=993` by default. Outlook
uses the normal Microsoft Graph scanner; the Outlook IMAP benchmark remains off.

The existing `withWorkflow` integration in `next.config.ts` must be included in
the deployed build. The installed Workflow SDK's Vercel backend automatically
provides storage, queuing and OIDC authentication on Vercel. No manually supplied
Workflow token or new app-level Workflow environment variable is required for
that deployment path. Do not configure a local/test Workflow backend in production.
Verify a deployed scan starts, progresses and completes through Workflow before
enabling access for users. This pass does not validate a deployed Workflow.

## Cleanup and Development Flags

There is no production cleanup enablement in this pass. Both providers' cleanup,
proofs and development sizes are rejected in production, even with flags set true.
`ORGANIZINBOX_FIXTURE_MODE` is always effectively false in production.

Leave these false/unset in production:

```text
GMAIL_BENCHMARK_ENABLED
GMAIL_CLEANUP_ENABLED
GMAIL_BULK_UNDO_PROOF_ENABLED
GMAIL_BULK_UNDO_HISTORY_SHADOW_ENABLED
GMAIL_HISTORY_SHADOW_PROOF_ENABLED
GMAIL_SCALABLE_CLEANUP_DEV_ENABLED
GMAIL_SCALABLE_POSTSTATE_AUDIT_ENABLED
GMAIL_SCALABLE_WORKFLOW_ENABLED
GMAIL_SCALABLE_WORKFLOW_FIXTURE_ENABLED
MICROSOFT_OAUTH_DEV_ENABLED
OUTLOOK_IMAP_BENCHMARK_DEV_ENABLED
OUTLOOK_CLEANUP_DEV_ENABLED
```

`GMAIL_CLEANUP_MAX_MESSAGES` remains capped at 100 and does not authorize production
cleanup. `GMAIL_SCALABLE_STORE_ADAPTER` is forced to `prisma` in production.
No Stripe variables are required to enable connection/scanning; billing was not
changed or validated here.

Existing optional cleanup retention settings remain unchanged:
`CLEANUP_STATE_ACTIVE_TTL_SECONDS=1800`, `CLEANUP_STATE_UNDO_TTL_SECONDS=1800`,
`CLEANUP_STATE_TERMINAL_TTL_SECONDS=60`, `CLEANUP_STATE_LOCK_TTL_SECONDS=60`.
The scan/report state uses its existing one-hour expiry after saved updates;
there is no new scan TTL variable. Purge respects live leases and is asynchronous.

## Deployment Checklist

1. Keep both production provider flags false. Configure secrets through the deployment platform.
2. Confirm the existing DB migrations and encryption keys are present; do not rotate keys or replace the DB.
3. Verify OAuth app approval/audience and exact production callbacks with Google/Microsoft.
4. Deploy with the existing Workflow build integration and minute retention Cron. Confirm authenticated purge invocations succeed without provider requests.
5. Enable only the provider being validated and redeploy. Verify read-only OAuth/scan/report, session isolation, process recovery and expiry on the deployed app.
6. Check disabled providers show maintenance, `/api/dev/*` returns 404, `/app/dev/gmail-benchmark` returns 404, and `/app/cleanup` exposes no actions. No diagnostic panels or benchmark payloads should reach production clients.

Changing availability does not delete connections, jobs or reports. Redeployment
does not retroactively change environment variables in an older in-flight
deployment; drain old executions when disabling a provider operationally. Already
sent provider requests cannot be recalled. Production cleanup and billing remain
separate launch blockers.
