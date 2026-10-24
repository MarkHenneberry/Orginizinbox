# Bounded Outlook transient state

## Connection and reason for the change

On 2026-10-20 the owner confirmed Vercel Production DATABASE_URL starts with
postgresql:// or postgres://. db.ts uses ordinary PrismaClient with no Accelerate
extension/adapter. Thus the HTTP Accelerate/Data Proxy 5 MB response restriction
does not apply. Local files also classify as native, but were not used as proof of
production. Vercel connector access failed; no secret was printed/pulled and no
runtime/database request was made. No connection setting or billing changed.

Independent of proxy limits, rewriting a 17-24 MB encrypted value at each checkpoint
is excessive. Keep the current job, Workflow, lease, version CAS and financial
architecture, but change the storage representation of large Outlook state only.

## Representation and bounds

- Keep small jobs inline up to 512 KiB encrypted; Gmail stays on its existing format.
- Large Outlook roots contain the existing job header plus an encrypted manifest.
- Arrays are paged at most 100 items at a time, with serialized pages divided into
  at-most-32,768-character segments. This handles long IDs/metadata without assuming
  fixed message-ID lengths. JSON Date/toJSON semantics match the previous codec.
- Each segment is compressed then independently encrypted using the existing
  AES-GCM cleanup-state key/envelope. Bound encrypted chunks to 256 KiB and bounded
  decompression to 256 KiB per segment. This is not an encryption-key change.
- Chunk envelopes bind user, job, slot and digest. The authenticated parent binds
  exact array paths, order, segment digests and encrypted byte lengths. Missing,
  stale, swapped or malformed chunks fail closed. Keys contain only technical path
  hashes/page indexes, never message/folder/sender identifiers.
- Child fetches use at most 128 rows AND at most 2 MiB of ciphertext per query,
  plus ordinary row metadata. Parent presentation queries fetch at most four roots.
  Database responses never need one full recovery/deletion payload for new jobs.
- Node steps reconstruct the same job API in memory. Worker functions and exact
  move/restore/delete identity semantics are unchanged. Complete in-memory
  materialization is still needed once per new store invocation; this is not a
  lazy per-target worker rewrite.

The schema adds CleanupJobStateChunk(jobId, slot, encryptedPayload), composite PK
(jobId, slot), with a cascading FK to CleanupJobState. There are bounded storage
pages, not per-message Prisma records. Chunks inherit logical expiry and all
lease-safe physical purge/disconnect/discard behavior from the parent. The existing
CreditJobAccounting.activeStateJobId SET NULL behavior is untouched.

## Atomicity and recovery

Read a parent and uncached children under RepeatableRead. Paginated presentation
uses one snapshot so concurrent writes cannot hide an older recovery job between
pages. Every hydrated envelope still verifies user/job/version against its row.

The existing guarded parent CAS is first inside a Serializable transaction. Only
its winner writes changed chunks, removes obsolete chunks and applies the existing
credit accounting transition. Any error rolls back all three. Lost responses are
resolved through the next durable version; no mutation is retried by this storage
layer. Never publish orphan pages before accepting the parent. Initial inserts are
batched eight rows per createMany; child updates are limited to changed segments.
Chunked transactions use a bounded 15-second timeout, not an unbounded lock.

A per-repository/invocation cache retains only authenticated reconstructed segments
for one job. A fresh authenticated parent manifest must match their digest before
reuse. No global cross-request/user cache. After successful CAS the cache advances;
after rejected/rolled-back CAS it does not. Within one worker unit, later CAS reads
need only the fresh small parent, not all unchanged child rows again. A replacement
has no cache and fetches the bounded pages under a new consistent snapshot.

Old inline rows remain readable. The next large successful CAS migrates them
atomically; there is no eager production data conversion. Lease/ownership/version,
expiry, uncertain-dispatch rules, recovery precedence, credit reservations/debits,
no Undo refunds and no extra permanent-deletion charge remain unchanged.

## Size and operation model

Synthetic 10k fixture with 160-character identifiers, actual encryption and exact
returned-ID/original-folder/deletion ledgers:

| Shape | Storage chunks |
| --- | ---: |
| Frozen candidate pool plus frozen targets | 200 |
| Candidate pool plus verified-moved ledger | 300 |
| Restored ledger plus deletion ledger | 600 |

The full synthetic recovery/deletion fixture measured 3,543,255 encrypted child
bytes, a 142,280-byte manifest, a 9,332-byte largest child and a 1,108,923-byte
largest DB response. Compression/part counts depend on actual identifier lengths,
entropy and selected pool; these are not production payload measurements. Hard
page/segment bounds, not the compression ratio, protect individual responses.
The same fixture in the old monolithic envelope is 24,586,880 bytes.

Unchanged chunks are not rewritten. A normal 20-target checkpoint usually changes
one 100-target page (often 1-3 segments); status/metrics-only saves change the parent
only. Small inline jobs add no child reads/writes. The 10k initial candidate pool
uses ~100 child rows, inserted in ~13 model calls rather than 100 round trips.

Against the previous ~4,602-call verification-only worker model, add one snapshot
parent read plus bounded child-page reads per worker entry, and dirty-page writes
per batch. For 100 preparation steps and ordinary 160-character frozen identities,
roughly 5.4k-5.5k calls is a defensible planning range, plus initial acceptance and
browser status requests. It is not a measured SQL/billing count. Move/Undo steps
retain their financial/checkpoint boundaries and generally add several child
reads/writes per step; no per-message DB calls. Active status still reconstructs
the exact snapshot through bounded reads. Polling cadence/hidden-tab/idle behavior
does not change. Monitor real operation count and byte traffic for the next proof.

## Migration and rollout

Migration: 20261020120000_chunk_outlook_cleanup_state (one table/FK, no data rewrite).
Build/install never runs migrate deploy. Apply the migration explicitly before
running this revision against that database. It was NOT applied by this task.

1. Let old-deployment cleanup/Undo/delete/preparation Workflows finish; do not
   overlap old readers with new chunk-writing jobs. Preserve outstanding Undo state.
2. Apply the additive migration with the reviewed release process.
3. Deploy the new reader/writer code together, without changing cleanup flags.
4. Check small inline jobs first, then 1,379, then a controlled 10k selection.
5. Verify exact aggregate counts, replacement/re-entry, Undo before its deadline,
   deletion only with separate explicit consent, DB operation/byte counts and TTLs.

Old binaries cannot read the new manifest format. Once chunked jobs exist, rollback
must retain the new storage reader; do not roll back to an old monolithic reader
until all such state has expired/been safely finalized. Never delete restoration
state merely to make rollback easier. No TTL or Graph concurrency change was made.

Controlled repository/codec tests cover bounds, 10k identity ledgers, changed-only
writes, credit rollback/idempotency, replacement, stale owners, corrupt chunks,
legacy migration and cascade modeling. Those fixtures are not live PostgreSQL
fault injection or proof of Vercel throughput. A migrated isolated Postgres run and
controlled production validation remain deployment prerequisites, not an excuse
to exercise real mailbox mutations automatically.

The actual Postgres harness now includes a 10k chunk/credit/replacement/cascade
case. It could not run in this workspace because TEST_DATABASE_URL is unset; the
guard rejected startup before connecting, rather than using application DATABASE_URL.

References: [native connections](https://www.prisma.io/docs/postgres/database/connecting-to-your-database),
[Accelerate limits](https://www.prisma.io/docs/accelerate/more/faq).
