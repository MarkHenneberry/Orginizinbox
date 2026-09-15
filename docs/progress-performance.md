# Progress and polling performance

These are deterministic synthetic measurements and code-path estimates, not live
provider or Postgres benchmark results. No provider requests are needed to run the
targeted tests. Provider payloads, classifier decisions, mutation semantics, and
the normal Outlook `/me/messages`, `$top=100` sequential scan are unchanged.

## Durable writes

| Operation | Before | After | Scope |
| --- | --- | --- | --- |
| Outlook 10k scan, 100 main pages at 1 second/page | 102 snapshots | 22 snapshots | Initial + progress + terminal |
| Same scan's progress persistence DML | 204 row updates | 44 row updates | ScanState + Scan per snapshot |
| Outlook 500 cleanup + Undo | 155 checkpoints + 155 heartbeats | 155 checkpoints + due heartbeats only | Encrypted CleanupJobState writes |

For a 100-110 second scan, expect roughly 22-24 snapshots, depending on page timing.
The first page writes immediately; subsequent progress-only writes are at least
five seconds apart. Initial state, fallback reset, final report, and errors bypass
coalescing. There is no delayed/background final flush.

Scan ownership is still checked and renewed at provider request boundaries, even
when a progress snapshot is skipped. In the uncontended Graph coordinator, each
request still has two fence updates and two slot claim/release updates. At about
107 requests, those roughly 428 updates are unchanged: progress plus request
coordination is approximately 632 -> 472 updates (about 25% fewer), excluding
acceptance, slot initialization, Workflow bookkeeping, retries, and token refresh.
The 78% reduction in progress writes is NOT a 78% reduction in all database work.

Outlook's 155 payload checkpoints comprise two preparation saves, 77 cleanup saves,
and 76 Undo saves. Dispatch intent, returned IDs, verification, safety context, and
terminal state are all preserved. The ten-minute lease is freshly acquired for
each Workflow step. Redundant renewal is gated to once per 30 seconds within that
step; typical shorter steps need no extra renewal. A rejected due renewal stops
work. CAS ownership/expiry checks and per-request fences remain mandatory.

Thus checkpoint-plus-heartbeat updates fall from 310 to about 155, not total job
database writes. Job aggregate updates, step claim/release, provider coordination,
confirmation/Undo acceptance, and report invalidation are unchanged. Longer steps
still renew. This does not shorten the existing lease takeover window.

Gmail scalable cleanup already persists meaningful operation/dispatch boundaries;
none were removed. Legacy small Gmail cleanup progress uses its existing local
store, so its progress callbacks were not a Prisma-write optimization target.

## Browser requests

All scan and cleanup pollers are single-flight, abortable on replacement/unmount,
and schedule only after the preceding response completes. They poll immediately,
then every second for ten seconds, every two seconds until a minute, and every
three seconds thereafter. Focus/visibility and benchmark cancellation request an
immediate refresh through the same queue. Terminal responses stop polling.

| Continuous operation | Before | After |
| --- | --- | --- |
| 100-second scan | About 100 | 49 |
| 110-second scan | About 110 | About 52 |
| Illustrative 300-second Outlook cleanup + separate 300-second Undo | About 800 | About 232 (116 each) |

Counts assume negligible response latency, no focus wakes, and no retries. These
durations are illustrative, not measured live cleanup times. Preparation is its
own polling period. Existing action requests are additional. Slow responses
reduce the new request rate further, instead of creating overlapping requests.
Legacy cleanup previously polled every 500ms; scalable Gmail/Outlook every 750ms.

Terminal/error persistence and applying received results are immediate. Polling
cannot promise instantaneous detection: maximum scheduled wait is three seconds
plus network/server latency. Intermediate scan counts may additionally lag by
the five-second snapshot window. Transport failures show a retry notice.

## Gmail memory

Consumed UID/API-identity lookup entries are deleted synchronously after their
classification callback. Leftovers are cleared after each batch. The temporary
lookup now peaks at one metadata batch, not the whole mailbox: with batch size
1,000, a 10k scan drops from about 10,000 pending entries to at most 1,000.

Eligible identity copies remain until final sender-group eligibility determines
the exact cleanup bridge. They are released after final target construction.
Required report cleanup targets and participation evidence are not discarded.
Aggregate-only progress counters expose pending, peak pending, and retained
eligible identity counts; the development benchmark shows pending/peak counts.
RSS remains a process-wide measurement, not exact per-scan allocation.

## Later live measurement

Compare the same mailbox and scan settings: duration, progress snapshot counts,
database query/transaction volume, status requests, and peak RSS. Compare 500-message
cleanup/Undo lease renewals and phase latency separately from mandatory checkpoints.
Test slow status responses, focus changes, cancellation, and multi-user contention.
Do not infer megabytes saved or provider throughput gains from entry counts alone.
