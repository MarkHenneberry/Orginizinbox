# Bounded Outlook verification chunks

## Production evidence and attribution

The user-supplied fresh 500-message trace measured 52,694 ms server time, 25 Workflow
steps, 25 Graph batch requests, 16,918 ms inter-step gaps, 32,053 ms worker time,
2,453 ms bootstrap and 1,269 ms startup. The signed residual was 1 ms.
Within workers: Graph calls 17,530 ms, instrumented DB spans 16,493 ms, persistence
7,117 ms, authorization 2,599 ms (including 1,590 ms entitlement), credentials 290 ms.
These are nested/overlapping spans, not independent costs to add together. In
particular Graph call time includes provider coordination (4,014 ms).

Before this pass each preparation step:

1. Claimed CleanupJobState, read its encrypted payload, decrypted/validated/cloned it.
2. Rechecked production access: entitlement/shared credit owner, billing snapshot,
   reservations/accounting, connection credentials/scopes and exact job ownership.
   The worker does not read the browser session cookie; HTTP start/status routes do.
3. Resolved active Microsoft credentials; a needed refresh remains single-flight.
4. Created a provider/coordinator and initialized its two durable request slots.
5. Reused saved folder/participation context, or established it once on first entry.
6. Ran one sequential Graph GET batch of at most 20 exact selected candidates,
   with the existing per-request fences/coordination and local safety evaluation.
7. CAS-checkpointed the exact cursor, approvals and exclusions; every CAS reread,
   authenticated/decrypted, serialized/encrypted and transactionally updated state.
8. Saved end-of-unit metrics/status separately, updated the aggregate CleanupJob,
   released the lease and returned to Workflow for another handoff.

The gap measurement covers SDK delivery/serialization, logs, scheduling, cold/import
startup and other time outside the measured worker units; it cannot identify which
internal Vercel component consumed it. There are 24 inter-step gaps, not 25 (first
startup is measured separately). The DB span covers only instrumented calls, not
all billing/purge SQL. It cannot be split exactly from one aggregate trace. Source
inspection identifies the repeated calls below; no live database measurement was run.

## Options and selected policy

Hold Graph request size (20), sequential execution and all per-request fences fixed.
Scale the measured mean gap of 16,918 / 24 = ~705 ms over N-1 handoffs:

| Max batches/step | Candidate reads/step | Steps for 500 clean approvals | Modeled gap | Approx. worker Prisma model calls |
| --- | --- | --- | --- | --- |
| 1 (before) | 20 | 25 | 16.92 s | 552 |
| 2 | 40 | 13 | 8.46 s | 360 |
| 5 (selected) | 100 | 5 | 2.82 s | 232 |
| 10 | 200 | 3 | 1.41 s | 200 |

Five captures most handoff/setup savings without doubling the work burst to ten.
Yield before another batch when preparation has consumed 15 seconds, including
initial folder/participation setup. Finish/checkpoint the current batch first.
This is a cooperative between-request budget, not a hard 15-second timeout:
an in-flight Graph read retains its existing 30-second attempt timeout and bounded
read retry/backoff behavior. No new retry policy or abort semantics were introduced.
Slow or heavily excluded mailboxes can require more than five steps.

The call model assumes valid unexpired credentials, fresh billing, uncontended
request slots, unconfirmed production preparation and 25 successful Graph batches:

- 14 per unit: job claim/read 2; access/entitlement/ownership 7; credentials 1;
  aggregate update 1; lease release 1; coordination slot upserts 2.
- 4 per Graph batch: two existing fences plus request-slot claim/release. All remain.
- 2 per state checkpoint: repository read plus transactional state update.
- Checkpoints = initial context 1 + Graph batches 25 + end-of-unit checkpoints N.
- Calls = 14*N + 4*25 + 2*(1+25+N). Hence 552 -> 232, ~58% fewer in this modeled
  worker path. This excludes fixed context Graph work, HTTP/poll queries, transaction
  protocol and retries. It is not a provider billing guarantee or an SQL benchmark.

The reduction is 25 -> 5 job claims/loads, access/credential resolutions, aggregate
updates and lease releases; coordination slot upserts 50 -> 10. Per-Graph-request
coordination/fencing is unchanged. Ciphertext CAS checkpoints drop 51 -> 31, not 5:
every 20-message batch remains durable, plus five metrics/status boundary saves.
The end-of-unit save is not blindly removed: it contains cumulative timings and may
publish the ready/failed transition that is not in the preceding batch checkpoint.

## Recovery and safety

The exact candidate pool, cursor, target IDs, counts, exclusions and folder context
stay only in the existing authenticated encrypted CleanupJobState. Per-step reuse
is local to its leased invocation. No global cache, schema, expiry, credit, API or
customer presentation changes. Preparation still reserves/spends no credits.

If the process is lost after three committed batches of a 100-message unit, its
last durable cursor is 60. A replacement cannot claim the live lease; after expiry
it reads/decrypts the last checkpoint, rebuilds the seen set and resumes from 60.
If the fourth Graph read completed but its CAS did not commit, that read may be
repeated. Exactly-once remote GET delivery is impossible across that crash window;
approval, cursor and counts are committed exactly once with owner/version CAS.
No previously committed 60 targets are re-read or double-counted; remaining targets
are not skipped. If the CAS committed but its response was lost, re-entry observes
the advanced version/cursor instead. Terminal replay performs no further Graph work.

Caught provider errors retain the existing failed-job policy, including committed
partial counts, rather than creating an automatic retry loop. Authorization denial,
disconnect, cancellation, expired/deleted state or a lost lease stop further requests.
An in-flight read may finish; stale ownership/version prevents its checkpoint from
overwriting durable state. Existing fences run before each request and retry.

Confirmation still does fresh authorization, paid-credit reservation and the same
independent mutation-time safety recheck. Moves/Undo still advance at most one
mutation batch per Workflow step, with zero automatic step retries and unchanged
dispatch/returned-ID/verification/Recovery Undo ledgers. Older recovery-job precedence
and browser polling remain unchanged.

## Expected latency and next proof

Handoff reduction alone saves about 14.1 seconds under the measured conditions.
Proportionally modeling persistence (51 -> 31 checkpoints) saves about 2.8 seconds,
and authorization plus credentials (25 -> 5 units) about 2.3 seconds. That gives
~33.5 seconds before any further claim/load/aggregate/slot-setup savings. These are
estimates, not additive measurements of all nested spans. Approximately 30-35 seconds
backend is plausible with similar provider/DB latency; slower calls or time-budget
yields can exceed it. The implementation has no measured new production latency yet.

Repeat the existing fresh 500-message read-only test: discard an unconfirmed old
selection first where allowed, choose the same sender, click Check once, keep the
tab visible, and do not confirm moves. Filter by the new trace ID. Expect configured
batches/step 5, budget 15000, normally steps 5, Graph batches 25, requested/checked/
approved 500 when unchanged eligibility permits. Compare actual workflowGapMs,
workerMs, databaseMs/persistenceMs, serverTotalMs and the client-ready sample.

Tests use the real worker/Workflow loop, actual encrypted codec and Prisma store
class against a lease/CAS-enforcing in-memory repository; Graph/auth/DB transport
are controlled fixtures. They prove application re-entry/state behavior, not Vercel
queue latency, live Postgres failure timing or real provider response reliability.
