# Outlook verification investigation: 2026-10-24

## Production evidence

The supplied failed start at displayed time 11:09:09 returned HTTP 400 in 116 ms.
Its trace ends after session, retention and authorization checks. There is no report
retrieval, candidate building, job creation or Workflow invocation for that request.
The matching production route rejects unsupported counts immediately at that point.

The later 100-message request succeeded: 100 approved, five sequential header
batches, one worker step, zero retries/throttles, 6,305 ms server time and 6,734 ms
click-to-visible time. Status polling returned 200 and stopped at readiness.
The candidate pool contained 1,096 messages. Its rounded choices are 100, 275,
550 and All 1,096. Thus a request thought to be about 500 may actually be 550;
the rejected request's exact count was not recorded, so that value is an inference.
An exact numeric 500 already passed the old route. Do not claim otherwise.

## Confirmed defects and fixes

The production route retained a separate 500-message cap after the service and UI
adopted relative selection. It now uses isOutlookCleanupCount, the same domain
decision as the service. Current report ownership, freshness, selected-pool bounds,
entitlement, confirmation and mutation-time safety remain server-authoritative.
Gmail's separate supported sizes are unchanged.

Rejected Outlook counts return the fixed INVALID_CLEANUP_COUNT code. The client
maps that code to safe actionable copy, retains selection and allows retry, without
creating a phantom job or beginning status polling. Outlook errors have role=alert.
Legacy 400 and server 503 responses also remain visible/retryable; raw response
error text is not displayed. No idle polling, router refresh or concurrency change.

A separate fault-injection regression reproduced a silent stop after a checkpoint
committed but its response was lost: the old-version failure CAS lost, while the
Workflow returned stop with durable status resolving. Preparation now rereads the
authenticated state and continues only an exact next-version, unconfirmed,
pre-mutation checkpoint with equal cursor and target count. The next worker must
claim/authorize again. A committed ready checkpoint finishes without replay.
Caught provider failures without such a checkpoint still stop. Cleanup and Undo
mutation/retry/credit behavior are not changed. This edge case is NOT established
as the cause of the supplied production trace, which never scheduled a worker.

## Quota and storage

An over-limit dashboard alone is not evidence that a particular query was refused.
The supplied successful authorization/status/verification writes show access was
working in that window; the rejected start used application HTTP 400, not a database
error. Prisma documents a temporary 24-hour restore window; account/grace status
was not inspected. No billing/plan/access setting or production database was changed.

Chunk codecs, paging, encryption, CAS and transaction/lease rules are unchanged.
Offline fixtures cover bounded 10k state, multi-step preparation and recovery; no
real PostgreSQL integration, migration or live mailbox request was performed.

## Further evidence if another exact 500-message request fails

Capture only the start HTTP status, fixed error code, submitted numeric count and
X-Outlook-Verification-Id; then the same correlation's last progress/end-to-end
aggregate and Workflow terminal status. Include a normalized Prisma code if logged.
Never share cookies, authorization headers, provider bodies, IDs or database URLs.

New log: Outlook verification request failed, containing correlationId, action,
fixed reason, optional safe count and allowlisted persistence error class/code.
For example P2021 distinguishes a missing table from P2028 transaction failure;
P6003 explicitly signals a plan-limit error when that transport reports it. Raw
exceptions, query arguments, response bodies and identifiers are never logged.
These events add no database writes.

Vercel project discovery worked but the runtime-log API returned 403. The production
diagnosis relies on the operator-supplied trace, not independently retrieved logs.

Reference: [Prisma Postgres quota/grace behavior](https://www.prisma.io/docs/postgres/faq).
