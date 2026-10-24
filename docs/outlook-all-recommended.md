# Outlook relative selection and large jobs

## Product limit audit

Removed Outlook's fixed 5/25/100/500 choices in the page and shared client, its
client-side 500 maximum, the development domain maximum, and the production service
validator's separate 500 maximum. Updated the corresponding spec and rollout docs.
The API forwards the count to this same service; there was no other 500-target
bound in candidate construction, Workflow loops, encrypted state, move/Undo,
financial accounting or permanent deletion. Tests retain 500 as a regression case,
not a maximum. Graph scan `$top=500`, HTTP status 500, historical benchmark samples,
credit pack sizes and Gmail's independent 250/500 controlled sizes are unrelated
and unchanged.

Selection counts only current selected groups' Potential cleanup, not Review or
Protected. Offer rounded ~10%, ~25%, ~50% and All recommended, removing duplicates
and zeros. Round small amounts to 5, then 10/25/50 as amounts grow; preserve already
tidy multiples of 5 such as 75 and 125. Always retain the exact full total:

Omit the approximate percentage if rounding changes it by more than five percentage
points (especially tiny selections), rather than labeling half a selection as ~10%.

| Selected potential | Choices |
| --- | --- |
| 80 | 10, 20, 40, All 80 |
| 300 | 30, 75, 150, All 300 |
| 500 | 50, 125, 250, All 500 |
| 1,379 | 150, 350, 700, All 1,379 |
| 10,000 | 1,000, 2,500, 5,000, All 10,000 |

Default to All; retain the chosen percentage as groups change and recompute the
numeric count. If rounding removes that choice, use All. Zero selection offers no
amount and disables Check. Submit a positive safe integer, never a browser target
list or an unlimited sentinel. Server ownership/report freshness/eligible groups
and current selected Potential total remain authoritative. Old ready/recovery jobs
keep their frozen requested amount independently of the new selector.

## Work, progress and finance

10,000 candidates require 500 sequential Graph header batches and normally 100
Workflow preparation steps. Keep at most five batches per step and the cooperative
15-second budget; slow calls/exclusions can require more steps. Persist exact
cursor/decision state after every batch. Existing transient TTLs do not change.

Status exposes only an added aggregate candidate-pool total alongside checked,
approved and excluded. Progress reads those existing snapshots; it adds no DB
calls or telemetry writes. The denominator is the frozen pool, not the desired
approval count: exclusions may require checking more candidates than requested,
and preparation may finish before the pool is exhausted. No fabricated completion
percentage. Existing single-flight adaptive polling pauses hidden tabs, stops at
ready/terminal states and remains off while idle. No new availability loop.

Verification spends/reserves nothing. Confirmation's existing atomic CAS/credit
transaction reserves only the frozen approved count and rechecks available funds.
Only verified moves spend; exclusions, failures and uncertainty do not. Undo does
not refund; separate permanent deletion costs nothing extra. No financial code
changed. Unfunded confirmation fails before provider mutation.

10,000 approved targets move in 500 durable mutation steps, each with at most 20
targets and separate final recheck, dispatch-intent, returned-ID and verification
boundaries. 100-message logical chunks are presentation, not a product limit.
Undo uses the exact verified-moved ledger and encrypted original folders in 500
bounded steps. Preserve the existing zero mutation retries and uncertainty stop.
Permanent deletion keeps its separate confirmation and five-target step limit.

A replacement resumes a preparation cursor after ownership allows it; uncommitted
read-only GETs can repeat but cannot duplicate committed approvals. A recorded
move response can resume verification only; an ambiguous dispatch must never be
repeated. Recovery Undo excludes uncertain IDs. Older mutation/recovery precedence,
all protection rules, token refresh, disconnect fences and expiry remain unchanged.

## Expected time and database model

The supplied live measurements are 7.5 seconds for 100 and 32.5 seconds for 500.
A simple extrapolation is about `1.25 + 0.0625*N` seconds: ~1 minute for 1,000,
~5 minutes for 5,000 and ~10-11 minutes for 10,000. These are not measurements or
promises; full encrypted-payload rereads/rewrites, network, exclusions, throttles
and budget yields can increase them materially. Do not show a falsely precise
dropdown ETA before a larger live trace validates that scaling.

Reuse the previous uncontended production model, not a provider-billed SQL count:
`B=ceil(N/20)`, `S=ceil(B/5)`, checkpoints `1+B+S`, worker Prisma model calls
`14*S + 4*B + 2*(1+B+S)`. Excludes HTTP start/status, fixed safety-context requests,
transaction protocol, financial changes, contention/retries and stale billing.

| Candidates | Graph batches | Steps | Checkpoints | Modeled worker calls |
| --- | ---: | ---: | ---: | ---: |
| 500 | 25 | 5 | 31 | 232 |
| 1,000 | 50 | 10 | 61 | 462 |
| 5,000 | 250 | 50 | 301 | 2,302 |
| 10,000 | 500 | 100 | 601 | 4,602 |

There are no per-message Prisma rows/writes. Mutation/Undo retain more checkpoints
and fresh authorization per step; do not confuse the verification table with total
cleanup costs. Existing full-payload snapshots mean byte traffic grows faster than
operation count in the legacy inline format; large Outlook jobs now use the bounded
storage below. Add chunk reads/changed-page writes to this baseline operation model.

## Storage and platform caveats

The legacy sizing fixture uses synthetic 160-character IDs and the actual AES-GCM envelope,
including its existing double base64 encoding. No real mailbox values are sampled.
Candidates remain in the encrypted payload; recovery models all original/moved/
restored IDs and original folders, and deletion adds its own exact ledger.

| Targets | Base encrypted | Recovery encrypted | With deletion ledger |
| --- | ---: | ---: | ---: |
| 1,000 | 0.34 MB | 1.72 MB | 2.39 MB |
| 5,000 | 1.71 MB | 8.58 MB | 11.97 MB |
| 10,000 | 3.42 MB | 17.16 MB | 23.95 MB |

Decimal MB; actual ID lengths, selected pool, folders, participation index and
sender context change these values. Local 10k recovery encode/decode measured
~47/59 ms in an isolated fixture run, not Vercel timing. Repeating full snapshots
many times has nontrivial cumulative CPU/network/memory cost.

The owner confirmed the deployed Production URL uses native PostgreSQL, matching
the plain PrismaClient initialization (no Accelerate extension). The Accelerate
5 MB proxy response limit does not apply to that transport. The Vercel connector
could not access the project; no secrets were pulled or deployed-runtime query run.

Repeated 17-24 MB checkpoints are still excessive. Large Outlook jobs now use
[bounded authenticated encrypted chunks](outlook-state-storage.md), with a compact
parent manifest and a new cascading CleanupJobStateChunk table. Small jobs remain
inline. No provider, database connection, plan or secrets were changed. Apply the
reviewed additive migration before deploying this storage code.

References: [PostgreSQL limits](https://www.postgresql.org/docs/current/limits.html),
[Accelerate limits](https://www.prisma.io/docs/accelerate/more/faq),
[Prisma native connection pricing/limits](https://www.prisma.io/pricing).

## Validation and next live proof

Fixtures exercise real worker/Workflow-loop/store/codec code with controlled DB,
Graph and auth transports, including 10k preparation, 10k move/Undo functions,
1,379 durable worker move/Undo with real credit accounting functions, replay,
replacement, uncertain recovery and progress/UI handlers. They do not prove live
Postgres limits, Vercel scheduling, real 10k throughput or provider reliability.

First apply the storage migration and complete the deployment checklist in the
storage document. Then test All 1,379 read-only preparation, observing counts/timing/DB usage;
only the user can approve a live move. Increase toward 10k after measuring full
recovery-state size and runtime. Confirm all steps finish within the unchanged
active-state TTL, and test Undo before its displayed deadline. Long state rewrites
or provider throttles may cause expiry; no lifetime extension was added. Never
advertise an unbounded tested mailbox maximum from these fixtures.
