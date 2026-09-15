# Postgres concurrency and recovery proof

Run explicitly with `npm run test:postgres`. This suite is excluded from the normal
unit test glob. It loads the existing development database using Next's environment
precedence (`.env.local` before `.env`) without printing connection configuration.
It does not apply migrations or alter existing users, configuration files or secrets.

The test process supplies disposable encryption keys only for synthetic records.
Every test creates UUID-prefixed temporary users with synthetic provider credentials
and report data. Teardown deletes only the exact tracked user IDs, checks their
namespace, and verifies user/provider/scan-state/cleanup-state removal. Foreign-key
cascades remove dependent scan/job records. Teardown runs on ordinary test failures
as well as success; a hard-killed test process cannot guarantee hooks execute.
Do not terminate a run while its cleanup hook is running. If the test process is
externally killed, investigate only users under that run's `pg-proof-<UUID>` prefix;
never use a broad delete against the development database.

## Real versus substituted boundaries

Real: Prisma clients, Postgres serializable transactions and unique constraints,
encrypted ScanState/CleanupJobState codecs, production acceptance functions,
leases/versioned CAS, provider-specific disconnect, token refresh ownership/commit,
Gmail coordinator/executor and aggregate writer, Outlook runner and aggregate writer,
confirmation/re-dispatch and exact Undo ledgers. Re-entry creates fresh store/runner
instances and reads Postgres rather than carrying forward a simplified fixture job.

Substituted: cookie-session context, Workflow scheduling transport and provider
responses. Provider methods simulate successful/ambiguous operations on synthetic
IDs only. HTTP guards reject non-database requests; IMAP construction is prohibited.
Provider request fences still execute real Postgres queries in the runner tests.
The test does not execute Graph/IMAP/Stripe requests or mailbox mutation.

Lease loss is simulated by retaining worker A's durable owner and expiring only
the test-owned lease in Postgres, then reclaiming from another Prisma client.
This tests the actual SQL time/owner predicates but is not a Vercel worker kill,
real wall-clock clock-skew experiment or provider-side fault injection.

## Coverage

- Concurrent same-user scans produce one accepted scan; other users/providers proceed.
- Concurrent duplicate Gmail and Outlook cleanup requests return one job per exact
  acceptance key; a third unrelated user's cleanup proceeds independently.
- Scan and cleanup leases block early reclaim, allow expired reclaim, and reject
  stale ownership/version writes. Direct scan repository writes also exercise SQL fencing.
- Disconnect in each provider direction deletes/cancels only that provider's work;
  stale scan/cleanup workers cannot pass their real request fences.
- Concurrent token refreshes persist one rotated version; a replaced lease or
  disconnect prevents an older refresh from restoring/overwriting credentials.
- Gmail scheduling failure can be redispatched; a durable dispatch marker survives
  lost execution response, re-entry verifies rather than mutating again, and Undo
  consumes only its exact verified ledger. Terminal aggregate data is ID-free.
- Outlook scheduling failure can be redispatched; an uncertain second batch stops
  forward work, and re-entry restores only the first verified batch with exact
  returned IDs/original folders. Uncertainty remains visible after recovery.

## Bugs found

The first real run returned `P2034` for simultaneous Gmail and Outlook cleanup
acceptance. Both implementations handled duplicate keys (`P2002`) but not actual
serializable transaction conflicts. A bounded database-only retry now handles
rolled-back `P2034` transactions (three retries). The original unique-key lookup
still returns the existing job; scheduling and provider operations are outside
the retry boundary. The real Postgres regression and bounded-retry unit tests
cover this fix.

A repeat run exposed `P2034` in the reused scan's atomic progress update, after
acceptance had already succeeded. The same bounded database-only retry now covers
that transaction, preserving version/owner/expiry predicates. No scanner or
provider operation is retried by this helper.

## Remaining evidence needed

This is a small fault suite, not a load test. It does not prove Vercel queue delivery,
deployment restarts, runtime step retries, process death during a network call,
database outage/failover, multi-region clock skew, connection-pool limits or provider
remote side effects. These require controlled staging validation before calling
the complete production concurrency/recovery system production-ready.
