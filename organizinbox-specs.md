# Inbox Cleanup MicroSaaS
## Product, UX, Technical, SEO and Launch Specification

**Status:** Pre-build product specification  
**Platform:** Web application  
**Current implemented provider:** Gmail  
**Planned provider:** Outlook / Hotmail / Microsoft 365  
**Working product concept:** Inbox Reset  
**Final brand name:** TBD

---

# 0. Specification Maintenance Rule

This specification is the living source of truth for Organizinbox.

Whenever a future development decision materially changes, replaces, or contradicts something currently stated in this document:

1. update this specification first
2. clearly replace the outdated decision rather than appending contradictory guidance
3. update the implementation to match the revised specification
4. leave this document describing the application as it is actually intended to work

The codebase and this specification must not drift apart.

---

# 1. Product Definition

Build a web application that helps people with large, neglected Gmail or Outlook inboxes understand **what is creating the clutter**, decide what can safely be removed, and move thousands of unwanted emails to Trash in a small number of actions.

The product is not primarily an email client.

The product is not primarily an unsubscribe service.

The product is not primarily an AI assistant.

The product is an:

> **Inbox cleanup tool that diagnoses years of accumulated email and turns the mess into safe, understandable bulk-cleanup decisions.**

The core user journey is:

**Connect once → Scan → Report → Clean → Rescan / Continue → Disconnect when finished**

The core promise is:

> **See what's clogging your inbox. Clean thousands of unwanted emails safely.**

The SEO research strongly supports treating this as a discovery problem first and a deletion problem second. Gmail and Outlook already provide deletion tools. The missing piece is helping a user identify which senders and categories created the mess and what can be removed without regret.

---

# 2. Primary User Problem

The ideal customer is not someone with 25 unwanted emails.

The ideal customer thinks:

> "I have 18,000 emails and don't even know where to begin."

Typical states include:

- thousands or tens of thousands of emails
- thousands of unread messages
- years of accumulated newsletters
- years of social-network notifications
- promotional email overload
- automated notifications
- shipping and delivery emails
- old account alerts
- storage pressure
- uncertainty about which senders create the most clutter
- fear of deleting something important
- reluctance to give an unknown service unrestricted inbox access

The research identified recurring user language around "thousands of emails", "all at once", "from one sender", "storage full", and especially cleaning without losing important email.

---

# 3. Launch Customer Segments

Prioritize:

### Primary

Long-time personal Gmail users with approximately:

**5,000 to 100,000+ accumulated emails**

Particularly users with:

- huge unread counts
- years of Promotions/Social email
- Gmail storage pressure
- many recurring senders

### Secondary

Long-time:

- Outlook.com users
- Hotmail users
- personal Microsoft accounts
- Microsoft 365 users where organizational policies allow connection

### Later

- professionals managing very high-volume work inboxes
- small business owners
- productivity enthusiasts
- privacy-focused technical users
- multiple-account households

The research ranks long-time Gmail users first, Gmail storage users second, and long-time Outlook/Hotmail users third as launch segments.

---

# 4. Product Positioning

## Category

**Inbox cleanup tool**

Secondary descriptors:

- email cleanup tool
- inbox cleaner
- email cleaner
- Gmail cleaner
- Outlook cleaner

These terms are useful for search/category understanding, but should not constitute the differentiated value proposition.

## Primary headline concept

> **See what's clogging your inbox.**

## Primary outcome

> **Clean thousands of unwanted emails safely.**

## Safety proposition

> **Review every group first. Important mail stays protected. Deleted mail goes to Trash.**

## Privacy proposition

If the architecture described in this specification is implemented correctly:

> **Connect. Clean. Disconnect.**

This means provider credentials persist across ordinary navigation until the user explicitly disconnects, separately removes Google authorization, credentials become invalid, or another genuine authentication failure occurs. Normal Disconnect destroys every provider credential held by Organizinbox and ends the application session; it does not necessarily remove Organizinbox from the connected-app permissions shown by Google. Inbox contents are not persisted. The persistent Organizinbox session and ProviderConnection are separate from temporary mailbox/report state.

## Provider proposition

Current implemented provider:

> **Works with Gmail.**

Outlook.com, Hotmail, and Microsoft 365 remain planned provider targets. Public Outlook pages may explain the intended workflow, but while Outlook support is incomplete they must clearly say Outlook support is coming soon and must not present a functional Microsoft connection as normal product behavior.

The research rates "See what's clogging your inbox" as the strongest differentiating positioning angle and "Clean without deleting anything important" as one of the strongest trust/conversion messages.

## Product Copy System

The primary product message is:

> **See what's clogging your inbox.**
>
> **Clean thousands of unwanted emails safely.**

The standard supporting explanation is:

> Organizinbox finds the clutter, protects messages that look important, and helps you clean it up in a few clicks.

The standard cleanup reassurance is:

> Unwanted email goes to Trash. Nothing is permanently deleted.

User-facing copy must use short sentences, plain language and concrete verbs. Lead with what the user gets. Keep paragraphs short. Remove repeated reassurance and implementation detail from normal product surfaces. Terms such as IMAP, OAuth state, provider connection, API identifiers, metadata pipeline, worker architecture and token introspection belong in implementation or narrowly relevant technical documentation, not ordinary product copy.

Marketing and SEO pages may use natural search language such as `delete old emails` and `delete thousands of emails`. When describing the actual Organizinbox action, use `Move to Trash` and state that nothing is permanently deleted. Organizinbox performs the Trash action only after explicit user confirmation; do not describe the product as merely taking the user to a final step.

The voice is calm, straightforward, trustworthy, useful and competent. It must not be cute, alarmist, salesy, legalistic or verbose. Do not overuse `safe`, `secure`, `smart`, `powerful` or `AI`; demonstrate safety through specific behavior.

Protection language must describe evidence conservatively. Prefer `Looks like account or transactional mail` and `We found signs these messages may be important` over claims of semantic certainty. The plain-language protection principle is:

> **When we're unsure, we leave it alone.**

Report language emphasizes decisions rather than implementation. Prefer `3,080 emails you may want to clean` over `3,080 cleanup candidates`. Recommendation labels remain `Very High`, `High`, `Review` and `Keep`, explained in plain language without numeric confidence percentages.

Button hierarchy:

- Primary: the main next action, such as `Clean my inbox`, `Scan my inbox`, `View Inbox Report` or `Move to Trash`.
- Secondary: an alternative or recovery action, such as `Back to Inbox Report`, `Back to homepage`, `Rescan` or `Account`.
- Tertiary: low-priority text navigation where appropriate.

CTA labels use sentence case. Equivalent actions use the canonical labels `Clean my inbox`, `Scan my inbox`, `Return to Inbox Report`, `View Inbox Report`, `Move to Trash` and `Try connecting Gmail again`.

---

# 5. Competitive Strategy

Do not attempt to out-feature Clean Email.

Do not attempt to become another full email-management platform.

Do not make unsubscribe the primary product.

Do not assume one-time pricing or privacy alone is a moat.

The competitive product should win by combining:

1. **Whole-inbox diagnosis**
2. **Excellent sender analytics**
3. **Cross-provider support**
4. **Transparent cleanup recommendations**
5. **Extremely strong protection against accidental removal**
6. **Minimal inbox-content access**
7. **A deliberately temporary connection workflow**
8. **Simple one-session cleanup UX**

Primary competitive threats:

### Clean Email

Strength:
mature, cross-provider, feature-rich.

Our differentiation:
simpler diagnosis/reset experience rather than ongoing email-management suite.

### Mailstrom

Strength:
large-backlog cleanup and powerful grouping.

Our differentiation:
less manual decision-making and better guided recommendations.

### Gmailytics

Strength:
very strong sender-first Gmail analytics.

Our differentiation:
Outlook support, deeper classification, stronger safety logic, temporary-connection story.

### Email Slayer

Strength:
large inbox, sender analytics, local processing, one-time purchase.

Our differentiation:
web-based, Gmail + Outlook, richer safe-cleanup guidance.

### Ciela

Strength:
Gmail + Outlook + IMAP, local privacy model.

Our differentiation:
web-based product experience, diagnosis system, stronger acquisition/SEO system and safety explanations.

### Gmail / Outlook themselves

Strength:
trusted and free.

Our differentiation:

> Native email tools help users remove clutter they already know about.

Our product should help them discover clutter they **didn't know was responsible for the inbox problem**.

That is the fundamental competitive wedge.

---

# 6. MVP Product Scope

Version 1 MUST include:

- Gmail connection
- Microsoft/Outlook connection
- mailbox scan
- scan progress
- sender analysis
- sender ranking
- category analysis
- age analysis
- unread/read analysis
- email-count analysis
- storage analysis where reliably available
- cleanup recommendations
- cleanup-confidence explanations
- protected-email rules
- group review
- individual group selection/deselection
- bulk Trash action
- cleanup progress
- cleanup results
- undo/recovery support where technically practical
- disconnect provider
- clear scan data
- pricing/payment
- privacy/security/data-access documentation

Version 1 does NOT need:

- full email client
- reading inbox messages
- composing emails
- email sending
- AI reply generation
- summarization
- calendars
- snooze
- daily digest
- ongoing inbox filtering
- complicated user-created rules
- mobile apps
- Yahoo
- iCloud
- generic third-party IMAP providers beyond Gmail IMAP/XOAUTH2
- permanent deletion
- enterprise admin tools

---

# 7. Critical Product Principle

## Never permanently delete email in MVP.

For Gmail, scanning uses Gmail IMAP/XOAUTH2 because it is the preferred large-mailbox scan transport. Final cleanup candidate resolution uses the Gmail REST API so the cleanup engine receives native Gmail API message IDs directly before mutation. Approved Gmail cleanup mutation uses the Gmail REST API because Trash movement is explicit and auditable.

Gmail cleanup flow:

- scan mailbox metadata using IMAP/XOAUTH2
- build the transient Inbox Report from IMAP metadata without persisting message-level data
- when the user approves a sender cleanup group, resolve the exact final candidate set with Gmail REST `users.messages.list` using conservative query criteria based on the normalized sender address from the active report
- inspect only minimal Gmail REST metadata for resolved candidates, including the allowlisted protection headers needed for the final safety recheck
- use native Gmail API message IDs returned by Gmail REST directly for mutation
- move only approved messages to Trash using the Gmail API
- prior tiny development validation may use Gmail `users.messages.trash` for explicit per-message Trash semantics
- the controlled 100-message development validation uses exactly one Gmail `users.messages.batchModify` request with `addLabelIds: ["TRASH"]` and `removeLabelIds: []`, followed by separate per-message verification
- never implement `users.messages.delete`
- never implement `users.messages.batchDelete`
- never implement IMAP `EXPUNGE` as an Organizinbox cleanup action
- never permanently delete mail

Do not rely on converting ImapFlow `message.emailId`, Gmail `X-GM-MSGID`, or any IMAP object identifier into Gmail API message IDs for production cleanup. IMAP identifiers may be used transiently for scan internals where appropriate, but final cleanup mutation must operate on native Gmail API IDs resolved through Gmail REST.

Google's current API documentation explicitly recommends `messages.trash` instead of permanent deletion, and Gmail label modification supports moving messages to Trash by adding the `TRASH` label.

For Microsoft, move messages to the well-known:

`deleteditems`

folder using Microsoft Graph.

Every user-facing deletion label should therefore use wording such as:

**Move to Trash**

rather than:

**Permanently Delete**

A simple UX may still say "clean" or "remove", but the confirmation interface must explain exactly what happens.

---

# 8. Primary User Journey

## Step 1: Landing Page

User arrives from:

- Google search
- ChatGPT search
- Bing/Copilot
- Perplexity
- Reddit
- word-of-mouth
- direct visit

Hero:

> **See what's clogging your inbox.**
>
> Organizinbox finds the senders and old email taking over your inbox, then helps you clean thousands of messages safely.

Primary CTAs:

**Clean my inbox**

Secondary provider path:

**Outlook support**

Until Outlook is implemented, the secondary Outlook path should lead to honest Outlook information, not an unfinished Microsoft OAuth flow.

Trust statements directly below:

- Nothing is permanently deleted.
- Unwanted email goes to Trash.
- We don't sell your inbox data.
- Disconnect when you're finished.

---

# 9. Connection Flow

User selects:

### Connect Gmail

Outlook users may open an Outlook information page while support is coming soon, but normal production navigation must not send them into Microsoft OAuth until Outlook support is implemented and this specification is updated.

Before OAuth, show a short explanation:

> ### Connect Gmail
>
> Organizinbox needs access to scan your inbox and move messages you approve to Trash.

Then list the concrete limits:

- We don't read email bodies.
- We don't download attachments.
- We don't send email.
- We don't permanently delete email.
- We don't store your inbox.

Primary action: **Connect Gmail**

Secondary action: **Back to homepage**

Link to Data Access for the full technical detail.

This explanation should exist before the third-party OAuth consent screen so the permission request is contextualized.

---

# 10. Permission Strategy

Use the minimum practical permission model.

## Gmail

The preferred Gmail architecture is:

**Google OAuth + Gmail IMAP over TLS + XOAUTH2**

This direction replaces a REST-per-message scan as the preferred Gmail path. The reason is product-critical performance: Organizinbox is intended for inboxes with tens of thousands of messages, and a user with roughly 50,000 messages must not wait hours for an Inbox Report.

The target experience is a usable Inbox Report for a 50,000-message Gmail mailbox in approximately **3-5 minutes**, subject to real benchmark validation. This is an engineering target, not a public marketing claim until measured.

Using Gmail IMAP requires broad Google Gmail authorization. Google's authorization screen may describe capabilities that are broader than Organizinbox's implemented behavior, including capabilities such as reading, sending, or permanently deleting email.

Organizinbox must not hide this. The product must clearly distinguish:

> what Google's OAuth permission technically permits

from:

> what Organizinbox's deployed mailbox processor actually implements

Organizinbox intentionally exposes only the operations required for the product:

- scan allowlisted mailbox metadata
- identify cleanup groups
- move mail the user approves to Gmail Trash
- disconnect by destroying Organizinbox's locally held provider credentials
- separately request Google-side authorization removal when the user explicitly chooses that deeper action while still connected

The Gmail mailbox processor must not implement email sending, SMTP through the user's mailbox, draft creation, reply/forward behavior, full-message body reading, attachment downloading, permanent deletion, mailbox expunge, or generic arbitrary IMAP fetch APIs.

The Google OAuth callback must positively verify that the granted token supports the Gmail capability required by the scanner. Use this evidence order:

1. If Google's token exchange response includes a `scope` field, require `https://mail.google.com/` explicitly. A present scope list without that value is a permission denial and must not be retried.
2. If the token response omits `scope`, obtain the authenticated Google identity and run a Gmail IMAP/XOAUTH2 authentication-only probe. The probe must use the installed IMAP client's verification mode, must not list or select a mailbox, and must not fetch messages.

The IMAP capability probe is preferred over tokeninfo as the missing-scope fallback because it proves the exact transport Organizinbox needs rather than making an auxiliary scope-diagnostic endpoint a callback dependency. Use aggressive timeouts and at most two attempts. Retry only allowlisted transient network, timeout, throttling, or 5xx-style failures. Do not retry authentication denial, explicit missing scope, OAuth denial, invalid authorization grants, or state failures. An IMAP authentication denial is an authorization/capability failure; an exhausted transient probe is a technical verification failure. These cases must remain distinct in internal diagnostics and must not both be presented as missing Gmail permission.

In development, each OAuth callback must emit one structured, non-sensitive lifecycle diagnostic with a random attempt ID and allowlisted stage/result values. It may include callback stage outcomes, whether the token response contained a scope field, probe attempt count, safe error class, timeout status, and HTTP status where applicable. It must never include an access token, refresh token, authorization code, OAuth state, email address, user ID, mailbox information, or provider response body. The local error page may show an allowlisted development error code; production must not render that code.

An isolated Google-hosted navigation error does not by itself invalidate a completed Organizinbox callback. During the disconnect comparison, Google briefly displayed `Something went wrong` while the associated callback still completed token exchange, explicit Gmail scope verification, provider-connection persistence, and session creation successfully. Treat this as an external provider-navigation anomaly unless it becomes reproducible; do not weaken or redesign callback verification because of that observation.

Do **not** claim:

> "We cannot read your email."

if the granted Google OAuth scope technically permits broader access.

Instead, if true, say:

> "Organizinbox does not store your inbox. Our mailbox processor temporarily processes only the metadata required to build your Inbox Report and perform cleanup you approve."

## Microsoft

Use delegated access.

Microsoft should continue toward:

**Microsoft OAuth + Microsoft Graph**

Use efficient pagination and `$select` to retrieve only fields required by the normalized Organizinbox model. Outlook does not need to use the same transport as Gmail. Provider-specific transport can differ while the application domain model stays provider-neutral.

The same privacy restrictions apply: no bodies, no attachments, no permanent mailbox metadata persistence, and no permanent deletion. Where Subject protection is implemented, Subject lines may be processed transiently only to derive protection signals under the rules in Data Retrieved During Scan; raw Subject text must not enter the normalized aggregate model or persistence.

Microsoft currently provides `Mail.ReadBasic` for basic mailbox properties and `Mail.ReadWrite` for read/write operations. Delegated `Mail.ReadWrite` is available for personal Microsoft accounts and does not inherently require admin consent, although an organization's policies may separately restrict third-party applications.




---

# 11. Scan Experience

After authorization:

> ### Analysing your inbox
>
> **14,284 of 38,217 emails analyzed**
>
> Finding:
> - high-volume senders
> - old emails
> - unread clutter
> - newsletters
> - promotions
> - notifications
> - possible storage savings

Show meaningful progress.

Do not leave the user staring at an indefinite spinner.

For massive mailboxes, scanning must:

- run as an independent long-running scan job
- use bounded memory rather than accumulating full mailbox results
- process provider metadata in streams or bounded batches
- immediately update in-memory report aggregates
- discard individual-message metadata after it contributes to aggregates
- tolerate provider rate limits
- retry safely where possible
- avoid duplicate processing
- expose progressive report/progress updates to the active session
- support at least 100,000-message accounts in architecture

Large-inbox capability is core product functionality, not an edge case. The research specifically identified 10k, 20k, 50k and even larger inboxes as high-value problem-aware search intent.

---

# 12. Data Retrieved During Scan

Default rule:

> **Retrieve the minimum mailbox information needed to make useful cleanup recommendations.**

Potential normalized metadata:

```text
transientMessageId
provider
senderAddress
senderDisplayName
senderDomain
receivedAt
isRead
providerLabels
userLabels
providerCategory
estimatedSize
hasListUnsubscribe
listId
autoSubmitted
precedence
isStarred
isImportant
isSent
isDraft
conversationId
subjectProtection
```

Provider-specific fields may differ.

Normalized mailbox records are transient processing objects, not ORM entities. The production application must be capable of producing report aggregates without inserting individual message records into the database.

Do not retrieve email bodies.

Do not retrieve attachments.

In non-production development only, the live Inbox Report may expose copyable classifier diagnostics built from aggregate counters already produced during the scan. Mailbox-wide output may contain aggregate state, recommendation, protection, cleanup-signal, safety-invariant, conversation-index and scan-timing counts. A Gmail-specific input diagnostic may additionally report aggregate counts for messages with any Gmail labels, recognized system-label occurrences, provider-category occurrences, messages and distinct counts for user labels, unrecognized system/category-shaped label occurrences, `Auto-Submitted` header presence and automation-indicating values. Scan-time Gmail provider categories that the current IMAP transport does not supply must be reported as unavailable, not as observed zero counts. It must never include raw user-created label names or raw header values. A selected-sender output may additionally contain the sender display name and domain already visible in the report. For the narrow purpose of distinguishing exact sender groups that share a display name, development-only sender diagnostics and search may expose the normalized sender address already used as the transient aggregate key; production must continue to replace that key before client serialization. Reason counts may overlap, but final state counts must reconcile as `Total = Ready + Review + Protected`. These diagnostics must not trigger another scan or per-message request, retain raw message metadata, or include message/thread/conversation identifiers, OAuth credentials or codes, raw headers, subjects, bodies, snippets, attachments or user-created label names. They must not be rendered or serialized to the client in production.

Subject lines may be fetched as part of the existing batched metadata scan and decoded transiently only to derive deterministic hard-protection signals. Subject is a brake, never an accelerator: it may move a message toward Protected or Review, but must never provide cleanup evidence, create Ready eligibility, or increase a sender recommendation to High or Very High. Raw Subject text must never be persisted, logged, sent to client or analytics, sent to an LLM, used for advertising or training, or retained after its typed protection signal is derived. Malformed or undecodable Subject input must contribute no cleanup evidence and must never increase eligibility.

The initial protection-only concepts are transactional records and account/security messages, represented by a small reviewed deterministic pattern set with phrase and word boundaries. Protection copy must remain cautious rather than claim semantic certainty.

For Gmail IMAP, the fetch set must be explicit and easy to audit. Initial Gmail metadata may include only fields genuinely required for classification and cleanup, such as:

- From
- internal/received date
- read/unread flags
- relevant Gmail labels
- approximate message size
- List-Id
- List-Unsubscribe
- Auto-Submitted
- Precedence
- Subject, transiently for protection only
- Gmail message/thread identifiers only transiently where operationally required

Gmail IMAP label retrieval uses `X-GM-LABELS`, exposed by ImapFlow as the message `labels` set with the server's label strings preserved. Normalize recognized system-label spelling and case for Starred, Important, Sent, Draft and other operational protections. Gmail inbox-tab categories such as Promotions, Social, Personal/Primary and Updates are not a reliable `X-GM-LABELS` message-fetch contract and must not be inferred by looking for Gmail REST API label IDs such as `CATEGORY_PROMOTIONS` in IMAP labels. The current Gmail scan-time classifier therefore treats provider category as unavailable. Provider-neutral category types may remain for providers or future efficient sources that actually supply them, but diagnostics and product decisions must not pretend the current Gmail IMAP scan observed a category.

Do not request message bodies, HTML bodies, plain-text bodies, snippets, attachment bodies, full MIME payloads, or arbitrary headers not justified by classification and protection needs.

For the current controlled Gmail cleanup limit, the full Gmail REST preview safety check must fetch Subject alongside the existing minimal metadata and reapply the same Subject protection rules. It must use `format=metadata`, request only the allowlisted headers, and never request snippet, body, or attachment data. Gmail REST message metadata also supplies `labelIds`, including category IDs where Gmail assigned them. The full preview may use those current REST label IDs as an additional safety gate, including Personal protection and Promotions evidence, even though the scan-time IMAP report has no category input. This provider-stage difference must remain explicit; REST-only category data must not be retroactively represented as scan-time classifier evidence. One REST metadata request per candidate is acceptable only for the current 100-message controlled limit. A very short-lived transient confirmation snapshot may then avoid downloading stable Subject and structural headers again, provided confirmation immediately rechecks every candidate against current mutable Gmail label protections as specified in the cleanup architecture. Before unrestricted or 1,000+ cleanup, design and validate a quota-efficient, deliberately paced strategy; do not assume the current per-candidate preview and post-mutation verification paths scale to large cleanup sets.

---

# 13. Normalized Provider Layer

The cleanup engine must not be tightly coupled to Gmail.

Create a provider abstraction conceptually similar to:

```text
MailboxProcessor

getMailboxProfile()

scanMetadata()

searchCleanupGroup()

moveApprovedMessagesToTrash()

disconnect()
```

Implement:

```text
GmailMailboxProcessor
MicrosoftMailboxProcessor
```

Later providers can implement the same provider-neutral contract, even when their transport differs.

The application-facing provider capability surface must not expose operations Organizinbox does not need. Do not implement:

- `sendEmail()`
- `createDraft()`
- `reply()`
- `forward()`
- `getFullMessage()`
- `getMessageBody()`
- `downloadAttachment()`
- `permanentlyDelete()`
- `deleteForever()`
- `expungeMailbox()`
- arbitrary provider fetch/query methods that can request full message content

The domain layer receives transient normalized records and aggregate report snapshots. Provider-specific API or IMAP shapes must not leak throughout the application.

---

# 14. Inbox Report

The scan result should be the core product experience.

It must immediately answer:

> **What caused this mess?**

Example:

# Your Inbox Report

**38,217 emails**

**21,493 emails you may want to clean**

**8,241 unread for more than one year**

**217 recurring senders**

**Potential storage recovery: 3.1 GB**

Only show storage figures when provider data makes them defensible.

Report counts must expose three mutually exclusive final message states:

- **Ready**: individually eligible for cleanup after the sender/group recommendation gate
- **Review**: not hard-protected, but not recommended for cleanup
- **Protected**: at least one hard protection reason applies

The required invariant at report, category and sender/group level is:

```text
Total = Ready + Review + Protected
```

`Review` is a count bucket as well as a recommendation label. Review-count messages are never cleanup candidates. Do not call them uncertain candidates.

Then show major groups.

---

# 15. Biggest Inbox Offenders

This should be one of the primary views.

Example:

| Sender | Emails | Ready | Review | Protected | Oldest | Ready storage | Recommendation |
|---|---:|---:|---:|---:|---|---:|---|
| LinkedIn | 2,481 | 2,103 | 260 | 118 | 2017 | 1.2 GB | Very High |
| Amazon | 1,481 | 812 | 428 | 241 | 2015 | 460 MB | High |

The sender ranking should support sorting by:

- total message count
- unread count
- age
- recent frequency
- estimated storage
- cleanup confidence

"Who sends me the most emails?" was identified as a particularly strong hidden problem-aware search and product wedge.

The Senders report view is a complete searchable and sortable browsing workspace. Search spans every sender group by visible display name and visible domain/address identity. Sorting changes only the order of that same complete collection; no sort may substitute a hidden subset or make a sender inaccessible.

At desktop and tablet widths with sufficient space, the Senders view uses a contained two-pane layout:

- the left sender-browser pane contains Search, Sort and the complete sender list
- Search and Sort remain visible while the sender list scrolls independently
- the sender list uses a responsive viewport-based height rather than extending the report page by hundreds of rows
- the right selected-sender detail pane remains visible while the sender list scrolls and may scroll internally when its own content exceeds the workspace height
- selecting a sender updates detail in place without route navigation, document scrolling, focus movement, search loss, sort loss or sender-pane scroll reset
- the selected row has a visible non-color-only treatment and an accessible selected state
- the first sender in the current sorted result is selected by default; when filtering removes the selected sender, select the first remaining result
- when no sender matches, show a clear empty result in both the browser and detail areas

Do not use browser-fixed positioning for sender detail and do not introduce competing nested scroll regions beyond the sender list and, only when needed, the detail pane. Overview, Categories and Old Mail retain their existing report layouts.

On phone widths, the Senders view becomes a normal stacked experience: controls and the complete sender list remain in document flow, selecting a sender reveals or updates detail below, and the interface must not force a cramped two-column layout or a small nested scrolling box. Search, sort, sender rows and selected state remain keyboard accessible with visible focus styles at every breakpoint.

Sender detail must show Total, Ready, Review and Protected counts that reconcile exactly. Show a cleanup CTA only when the sender/group recommendation is High or Very High and Ready is greater than zero. For Review, Keep or Ready zero, show a passive `Nothing recommended for cleanup` state. A qualifying mixed sender CTA must make clear that only the Ready subset enters cleanup review. Server-side cleanup eligibility remains authoritative.

---

# 16. Category View

Normalize only into classes supported by the allowlisted metadata. The initial provider-neutral classes and user-facing labels are:

- `BULK_NEWSLETTER`: Newsletters & bulk mail
- `PROMOTIONAL`: Promotions
- `SOCIAL_AUTOMATION`: Social notifications
- `ACCOUNT_OR_TRANSACTIONAL`: Account & transactional
- `PERSONAL`: Personal
- `UNKNOWN`: Unknown

These classes describe metadata evidence, not message meaning. In particular, `ACCOUNT_OR_TRANSACTIONAL` must not be presented as proof that a message is a receipt, invoice, security alert or other specific document. Provider categories are useful only when a provider stage actually supplies them. The current Gmail IMAP scan does not reliably receive Promotions, Social, Updates or Personal/Primary categories through `X-GM-LABELS`, so those categories must not be claimed or inferred in the scan-time Gmail report. Gmail REST category `labelIds` remain available for current mutation-time safety checks.

---

# 17. Recommendation System

Do not simply label something:

**Junk**

Instead generate:

### Cleanup Confidence

Possible values:

- **Very High**
- **High**
- **Review**
- **Keep**

Avoid giving false numerical precision such as "97.8% junk" unless the classifier has actually been calibrated against labeled data.

---

# 18. Recommendation Signals

Use deterministic, provider-neutral and interpretable rules. The engine must keep three decisions separate:

1. message-level protection
2. sender/group recommendation
3. message-level cleanup eligibility

A sender is never classified as wholly safe to clean. Every message in a recommended group is independently protected or eligible. Protected messages remain excluded even when the rest of the sender group receives a High or Very High recommendation.

The governing principle is:

> **When we're unsure, we leave it alone.**

### Hard message protections

The following reason codes make a message ineligible for cleanup:

- `PROTECTED_STARRED`
- `PROTECTED_IMPORTANT`
- `PROTECTED_RECENT` for mail less than 30 days old
- `PROTECTED_USER_PARTICIPATED_CONVERSATION`
- `PROTECTED_PERSONAL` for a provider Personal category
- `PROTECTED_SENT`
- `PROTECTED_DRAFT`
- `PROTECTED_SENDER` when a user protection exists

User participation is detected without message content. During the scan, build a transient set of conversation identifiers from Sent-labeled messages. Any incoming message with the same conversation identifier receives `PROTECTED_USER_PARTICIPATED_CONVERSATION`. The set belongs to the active transient report lifecycle, must not be written to Prisma or logs, and must be destroyed when the report expires, cleanup completes, the user disconnects or the session is cleared. If participation cannot be re-established after report expiry, require a rescan before cleanup.

### Soft review and keep evidence

These reason codes move uncertainty toward Review or Keep but are not hard protections by themselves:

- `USER_LABEL_PRESENT`
- `TRANSACTIONAL_OR_ACCOUNT_LIKE`
- `UNKNOWN_MAIL_TYPE`

### Strong cleanup signals

- `HAS_LIST_ID`
- `HAS_LIST_UNSUBSCRIBE`
- `PRECEDENCE_BULK`
- `PRECEDENCE_LIST`
- `CATEGORY_PROMOTIONS`

### Supporting cleanup signals

- `CATEGORY_SOCIAL`
- `AUTO_SUBMITTED`
- `NOREPLY_STYLE_SENDER`
- `RECURRING_SENDER`
- `MOSTLY_UNREAD`
- `OLD_MAIL` for mail at least 180 days old
- `VERY_OLD_MAIL` for mail at least 365 days old

`CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL` and provider Personal/Updates handling are provider-neutral capabilities, not guaranteed Gmail scan-time inputs. They remain valid for a provider or future efficient Gmail input source that explicitly supplies categories. Under the current Gmail IMAP architecture they do not fire, and eligibility must continue to depend on the structural per-message evidence that is actually fetched. Do not synthesize category signals from sender identity, subject text or ordinary user-label names.

No-reply sender style is supporting evidence only. Gmail Updates alone is conservative account/transactional evidence and cannot produce High. Unknown mail that is old, unread, large or frequent still cannot produce High without independent strong bulk evidence. Age and message size never establish cleanup eligibility by themselves.

### Message eligibility

For each transient message, produce:

```text
eligibleForCleanup
protectionReasons
reviewSignals
cleanupSignals
mailClass
ageBand
```

The preliminary message eligibility gate requires no hard protection, an old age band and at least one strong cleanup signal. Final eligibility also requires its sender/group to receive High or Very High. Review and Keep groups have zero cleanup-eligible messages.

### Sender/group statistics

Aggregation must track at least total, protected, preliminarily eligible, unread, read, unread ratio, old, very old, recent, first date, latest date, estimated bytes and recurrence. Estimated size is used only to rank already-eligible groups; it is never a safety signal.

### Recommendation rules

Recommendations are `Very High`, `High`, `Review` and `Keep`, with no confidence percentages.

- High requires recurring sender evidence, age, at least one independent strong bulk signal and no hard protection on each eligible message.
- Very High requires multiple independent strong bulk signals, recurrence, substantial eligible volume, and predominantly old or very old mail.
- Review is advisory only and never cleanup eligible. Use it for plausible automation with incomplete or conflicting evidence, Gmail Updates, user labels, or a significant protected subset.
- Keep is used for personal mail, wholly protected groups and unknown mail without adequate bulk evidence.

Thresholds must be named constants, deterministic and covered by boundary tests. Supporting signals can strengthen or explain a recommendation but cannot replace the required strong bulk evidence.

---

# 19. Explain Recommendations

Each group should answer:

> **Why are you recommending this?**

Example:

### LinkedIn

**2,482 emails**

**Cleanup confidence: Very High**

Why:

- Mailing-list headers found
- This sender appears regularly
- Most eligible messages are older than one year

Suggested cleanup:

> **Move old notifications to Trash**

Keep:

- recent messages
- starred or important messages
- messages in conversations you participated in
- personal and uncertain messages
- messages outside the eligible bulk-mail group

This explanation is a core conversion and trust feature. Explanations must come from stable reason codes mapped to plain-language copy, not free-form generated text or an LLM. Show one to three primary reasons for each sender group and explain protected totals separately.

---

# 20. Safety Engine

The safety engine is one of the product's main differentiators.

The product should be biased toward:

**false negatives rather than false positives.**

It is acceptable to leave some unwanted email behind.

It is not acceptable to confidently recommend removing important email.

---

# 21. Default Protected Mail

Always exclude starred, provider-important, Sent, Draft, recent, provider-Personal, user-participated-conversation and explicitly protected-sender messages. Treat user labels, account/transactional evidence and unknown mail conservatively as Review or Keep evidence.

Do not infer message semantics that the metadata cannot support. The absence of a protection signal is not cleanup evidence, and a group recommendation must never override a message-level protection.

---

# 22. Recent Email Protection

Default:

**Messages received within the last 30 days are hard protected and cannot be selected for cleanup.**

Allow the user to change:

- 30 days
- 90 days
- 6 months
- 1 year
- custom

A conservative default should reduce accidental cleanup risk.

---

# 23. Sender Protection

Allow:

**Always keep this sender**

Users can protect:

- individual email address
- entire domain where appropriate

Protected senders should never be selected by future cleanup recommendations.

---

# 24. Review Before Cleanup

Review Cleanup follows one explicit staged flow: `SELECT -> REVIEW -> MUTATING / VERIFYING -> COMPLETE`. Only one stage is rendered at a time on desktop and mobile.

`SELECT` is the initial editable sender-selection workspace derived from the active report. It contains the complete sender list, Search, Sort, selection controls, selected sender and Ready counts, the message-count selector, `Check N messages`, and the development-only safety benchmark. Every sender group remains discoverable regardless of sort. High and Very High groups with Ready messages are selectable; Review groups, Keep groups and groups with Ready zero remain visible but disabled with their non-eligible state explained in text. Search spans display name, visible sender identity and domain. Search and sort change only the visible order and never clear existing selection. Clicking `Check N messages` enters an immediate working state that disables controls and explains that the messages are being rechecked against Gmail before anything is moved.

A successful check transitions to `REVIEW`; it removes the interactive selection workspace but retains the checked sender selection as frozen context. `REVIEW` is a read-only view of one exact transient candidate snapshot. Do not render Search, Sort, sender checkboxes, selection-changing actions, the message-count selector, `Check messages`, or `Run safety benchmark` in this stage. On desktop, preserve the established two-column layout: the left panel shows the checked sender groups as semantic read-only rows in the independently scrolling, viewport-bounded sender region, while the sticky right panel shows the cleanup summary and confirmation actions. The frozen panel summarizes selected sender groups, Ready capacity at check time and contributing groups without implying that every selected group contributed. Reuse the existing sender-row visual language and useful Sender, Recommendation, Ready, Review and Protected fields, but do not use disabled checkboxes as decoration or otherwise make the rows appear interactive.

The `REVIEW` summary shows the requested and resolved messages, contributing sender groups, final safety exclusions or safely skipped groups where useful, and that Protected and Review messages were left alone. Development diagnostics may remain visible but read-only. The primary action is `Move N to Trash`; the only selection-related secondary action is `Start over`. On mobile, render the cleanup summary and actions before sender context. Put the frozen rows in a collapsed read-only `Checked sender groups` disclosure so users do not have to pass the full sender list before reaching the primary action. Do not force the desktop columns or bounded nested scrolling onto mobile.

`Start over` invalidates only the current pre-mutation candidate snapshot, returns to `SELECT`, restores selection according to the existing default/current-selection product rules, and requires a new Check operation before Trash can occur. It never mutates Gmail or changes completed Trash or Undo jobs. Do not offer inline recheck, message-count changes, or benchmark actions from `REVIEW`. Once Trash mutation begins, `Start over` is unavailable.

The final Trash confirmation belongs to `REVIEW`. Cancel returns to the same frozen sender context and `REVIEW` summary without another Gmail check. Confirm uses that exact checked snapshot. If the snapshot expires or is invalidated before confirmation, never silently rerun resolution and never mutate; keep the frozen sender context visible, replace the right-side confirmation actions with the expired-check explanation and `Start over`, and require a fresh Check. Expiry is a state change inside `REVIEW`, not a return to `SELECT`. The checked selection and requested count cannot change during valid or expired `REVIEW`.

`MUTATING / VERIFYING` preserves the visible working states for moving messages and verifying the accepted provider mutation. `COMPLETE` shows the existing Trash or Undo result with the actions that remain valid, including Undo when available, Rescan inbox and Back to Inbox Report. Selection and Check controls do not reappear after Trash or Undo completes.

Transitions into `REVIEW` must be announced with `aria-live`. The Review heading may receive logical focus without trapping focus or causing an unexpected jump. `Start over`, Trash confirmation and all other actions remain keyboard accessible.

When Review Cleanup opens without explicit selection state, select every eligible sender group in the complete report by default. Eligible means High or Very High with Ready greater than zero. Never auto-select Review, Keep, protected-sender or Ready-zero groups. Make the default scope prominent with selected eligible-sender and Ready totals plus an obvious `Clear selection` action. After clearing, offer `Select all eligible` for the complete eligible collection.

Users may select one or multiple eligible sender groups. With an active search, `Select all eligible results` changes only eligible groups in the current filtered result and does not clear eligible selections hidden by the filter. Without a search, `Select all eligible` restores the complete eligible selection. Never label either action as selecting all senders. Search and sort never change selection on their own. The selection summary must separately show selected sender groups, selected Ready messages, Review messages left alone and Protected messages left alone.

Review, Keep and Ready-zero rows remain fully discoverable but intentionally non-selectable. Use disabled checkbox semantics, muted but readable styling, an explicit state badge and concise reason text without classifier internals. Review explains that evidence is insufficient for automatic cleanup. Keep explains that no messages are currently Ready or that current messages appear protected when that distinction is accurately available. Ready-zero rows explicitly show `0 Ready` and `Nothing available to clean automatically.` Do not rely on opacity or color alone.

On desktop, sender rows use one viewport-bounded independently scrollable region with search, sort and selection counts outside that scroll region in `SELECT`, and with the frozen checked-selection summary outside that scroll region in `REVIEW`. The cleanup action remains in the sticky right panel. On mobile, use normal document scrolling rather than a nested small scroll box. Interactive SELECT checkbox semantics and visible labels must communicate selectable and disabled states without relying on color; REVIEW rows are plain semantic content with no checkbox controls.

A requested cleanup count applies across the union of individually Ready messages from all selected eligible groups. The server revalidates every selected group against the current report and never accepts client-provided eligibility or counts. A cleanup batch may therefore contain Ready messages from multiple sender groups, but Review messages, Protected messages, Review groups and Keep groups never enter candidate resolution or mutation.

Cross-sender resolution is deterministic. Order selected groups by recommendation (`Very High` before `High`), then Ready volume descending, then original report index as a stable tie-break. Allocate the requested count in a capacity-aware round-robin across that order so one large sender does not accidentally monopolize a multi-sender request. Resolve each allocation using that sender's independently authoritative message-level evidence.

Resolve selected sender groups independently. A sender-specific identity, query, list or metadata-safety failure excludes that entire sender group from the cleanup attempt, records a safe enum reason and leaves all of its messages alone. Never partially trust an unresolved group and never weaken its query, sender matching or message checks. Successful independently verified groups may receive a deterministic round-robin redistribution of the remaining count up to their reported Ready capacity. A failed group contributes no candidates. If the successful groups still provide fewer safe candidates than requested, return `INSUFFICIENT_SAFE_CANDIDATES` and keep mutation unavailable.

Every Gmail REST request outcome must pass through one shared safe classifier before retry or cleanup decisions are made. For non-success responses, read only the HTTP status and the structured Google error `reason` required for classification, then discard the response body. A successful HTTP response must also be decoded and validated inside the typed Gmail API boundary. Persist or expose only an allowlisted internal reason: invalid query, authentication, permission denied, domain policy, user rate limited, project rate limited, daily limit, too many requests, provider 5xx, network error, timeout, not found, invalid provider response or unknown provider error. Never log, persist or render Google's raw response body, raw error message, request URL, query, message identifier, token or authorization data.

For HTTP 403, `rateLimitExceeded` and `userRateLimitExceeded` are retryable with the same bounded exponential-backoff policy used for HTTP 429 and provider 5xx responses. `dailyLimitExceeded`, `domainPolicy` and unrecognized or generic permission-denied 403 responses are not retried. Network failures and timeouts use bounded retries. Invalid authentication, permission/policy denial, exhausted throttling or transport retries, daily limits and unknown provider failures are global and abort the complete preview. A validated query-specific HTTP 400 invalid-query failure may remain local to that sender group. At the `messages.list` boundary only, HTTP 204 is normalized without JSON parsing to a successful empty result with `messages: []` and no next-page token. That sender group is successfully resolved with zero safe candidates, is not retried or counted as a provider failure, contributes no candidate IDs and creates no eligibility. This endpoint-specific interpretation does not claim why Gmail returned no body and does not change the meaning of HTTP 204 for mutation endpoints. A `messages.list` HTTP success other than 204 whose JSON cannot be decoded or whose allowlisted response shape is invalid is classified as an invalid provider response with the successful HTTP status retained. Because that failure is isolated to one authoritative sender query while other independently checked groups remain valid, it is sender-local, is not retried blindly, excludes the complete sender group and contributes no candidates. A message-specific metadata 404 or invalid success payload may likewise remain local because one message can disappear or become unusable between scan and cleanup; a `messages.list` 404 is global. Unknown or untyped failures default to a global unknown-provider classification rather than weakening safety.

Development cleanup diagnostics must distinguish selected, attempted, successfully resolved, failed, zero-safe-candidate and contributing sender-group counts; aggregate provider failure classes and local-versus-global failure counts; preserve partial stage timings, request counts and observed quota consumed; and distinguish observed units from projected units if cleanup completed. Each failed sender group may include only its displayed sender label/domain, safe stage, allowlisted reason, HTTP status, retryable flag and retries attempted. Every failed group must enter exactly one classified local, global-provider or global-application bucket. A terminal global failure with no failed group must enter an explicit global-application bucket. Diagnostics must show a failure-accounting invariant that passes only when classified failures equal failed groups plus any separately represented terminal global application failure. `Global failure: yes` with zero global-provider and zero global-application failures is invalid. Normal UI may state only that sender groups that could not be checked safely were left alone. Diagnostics must not contain Gmail queries, Gmail IDs, raw Subjects or headers, tokens, provider response bodies or full sender addresses that are not already intentionally displayed.

Before executing:

> ### Ready to clean 12,481 emails
>
> 7,421 promotions  
> 2,801 social notifications  
> 1,742 newsletters  
> 517 automated alerts

Then show:

**Protected: 4,281 messages**

because they were:

- recent
- personal
- important
- starred
- in conversations you participated in
- manually excluded

CTA:

**Move 12,481 emails to Trash**

Secondary:

**Review groups**

---

# 25. Destructive Action Confirmation

Confirmation text should explicitly state:

> These emails will be moved to your Gmail Trash / Outlook Deleted Items.
>
> They are not being permanently deleted by this application.

Require one deliberate confirmation.

Do not use manipulative countdowns or misleading urgency.

---

# 26. Cleanup Execution

Large cleanup actions must be processed in resumable batches.

Requirements:

- idempotent operations
- batch retry
- provider-specific throttling
- exponential backoff
- failure logging without message content
- progress counter
- pause/resume where practical

Every long-running scan, rescan, cleanup resolution, development safety benchmark, Trash mutation, Trash verification and Undo operation must expose an immediate, unmistakable working state. Disable every control that could duplicate or invalidate the active operation, use visible status text plus an indeterminate activity indicator when real percentage progress is unavailable, and expose the state with `aria-live` and `aria-busy`. Elapsed time may be shown. Do not fake percentages or phase progression. Animation must respect `prefers-reduced-motion`, and operation status must remain understandable without motion.

Each destructive or reversal action represents one logical operation. The transient server state must atomically claim cleanup resolution, Trash and Undo work before provider requests begin. Concurrent duplicate requests for the same active operation return or reuse its current safe state and must not issue duplicate Gmail work. A stale request after Trash completion must not issue another `batchModify`. Undo transitions once from available to in progress; after completed, partial, uncertain, failed or expired resolution it is consumed and the full restore operation must not be offered or executed again. Internal bounded retries for individual provider requests remain part of that same logical operation. Transient operation locks and counters contain only minimum application state and never mailbox-derived identifiers beyond the already required short-lived in-memory cleanup snapshot.

Cleanup preview is advisory; mutation-time safety is authoritative. The full preview recheck reads one minimal metadata response per candidate and evaluates sender, age, Trash, Starred, Important, Sent, Draft, Personal, Subject protection, user participation, explicitly protected sender and current strong evidence. That response may include only `labelIds`, `internalDate` and the allowlisted headers needed for those checks; do not split safety inputs across separate metadata requests.

After a successful full preview, Organizinbox may keep only native Gmail IDs, selected sender-group association, derived eligibility and validation timestamp in a very short-lived in-memory confirmation snapshot. Sender, internal date, Subject and structural bulk headers are stable message properties after receipt and need not be downloaded again inside that short window. Immediately before Trash, confirmation must still recheck mutable Gmail labels for every candidate, including Trash, Starred, Important, Sent, Draft and Personal/category protection, and must revalidate the unchanged active report, selected group eligibility, protected-sender policy and participation-state availability. A message starred or marked Important after preview must be excluded. If the snapshot expires or active state changes, block mutation, show the expired-check state, and require `Start over` followed by a fresh Check; never silently re-resolve. Never persist the snapshot or raw metadata.

The full preview metadata recheck and confirmation label recheck must use conservative bounded concurrency, explicit request timeouts and bounded retry/backoff for transient transport, throttling and provider 5xx failures. Do not use uncontrolled `Promise.all` fanout. Development diagnostics may report aggregate endpoint/request counts, retry counts, peak concurrency, p50/p95 request durations and estimated Gmail quota units, but never IDs, queries, tokens, Subjects or raw headers.

### Controlled 100-message Gmail development validation

The current Gmail batch validation is development-only and disabled by default. It requires `GMAIL_CLEANUP_ENABLED="true"`, a configured maximum no greater than 100, a current completed live Gmail report, its active transient participation set and an existing valid Gmail provider connection. The server hard-rejects requests above 100 regardless of the UI or environment configuration. Only High and Very High sender groups from the current report qualify, and the requested count cannot exceed the combined Ready count of the selected eligible groups.

Candidate resolution uses bounded Gmail REST `users.messages.list` requests per selected sender and native Gmail API message IDs. Each listed message is checked with one minimal REST metadata response against sender identity, age, Trash, Starred, Important, Sent, Draft, Personal/Primary, Subject protection, user participation, explicitly protected-sender policy and current strong per-message cleanup evidence. Search predicates may prefilter obvious current protections but never replace the metadata safety decision. Do not create one unbounded multi-sender OR query. Exclusion diagnostics use only allowlisted enum-style aggregate counts. Message, thread and conversation IDs, raw Subjects and headers, Gmail search queries and provider response bodies remain server-memory-only and must not enter copied diagnostics, logs, URLs, browser storage, analytics or Prisma.

Resolution must be honest about exact count. If the initial Check resolves fewer safe candidates than requested, mutation remains unavailable in `SELECT` and the user may explicitly choose a smaller count before running a new Check; protection must never be weakened to fill the requested count. If the confirmation-time recheck leaves fewer safe candidates, require `Start over` before the user changes the count or runs another Check. A ready preview requires deliberate confirmation and must still belong to the unchanged current report. Confirmation rechecks the exact approved IDs for mutable protections and must not perform a second independent selection, refetch stable headers or silently substitute different messages.

For an exactly 100-message approved validation, send one `users.messages.batchModify` request with `addLabelIds: ["TRASH"]` and `removeLabelIds: []`. HTTP success means only that the mutation request was accepted. Verify every attempted message separately using minimal label metadata, bounded concurrency and short bounded retries only for transient transport, throttling and provider 5xx failures. Track Verified, Failed and Uncertain with the invariant `Attempted = Verified + Failed + Uncertain`. Mark the active report stale after the mutation request is attempted; never manually adjust report totals.

Offer Undo only when every attempted message was verified in Trash and the one-shot Undo state is available. Keep the native IDs only in the short-lived in-memory cleanup job. Undo uses individual `users.messages.untrash` requests with the same bounded concurrency and retry policy. A successful untrash response returns a Gmail Message resource; inspect its returned `labelIds` as the primary post-operation verification. `TRASH` absent means Verified restored. `TRASH` still present means Failed. A successful response without usable label state is not automatically Verified: perform one minimal label-only `users.messages.get` fallback for that message, and classify an unresolved transient read as Uncertain. Do not issue mandatory verification reads after authoritative untrash responses. Preserve the accounting invariant `Attempted restore = Verified restored + Failed + Uncertain`. Undo does not make the old report current and preserves the original Trash result alongside the Undo result. Once Undo begins, duplicate user requests reuse the in-progress operation without issuing more untrash calls. Completed Undo remains consumed. Partial, uncertain, failed or expired Undo shows its actual result and must not blindly expose or execute the full Undo again.

Development-only cleanup diagnostics may show eligible groups available, selected and contributing sender-group counts, combined selected Ready capacity, safe aggregate distribution ranges, requested and resolved counts, aggregate exclusion reasons, mutation/verification/Undo accounting, safe enum operation states, duplicate-submission counts, stage timings, request counts, retry and concurrency measures, p50/p95 request durations, estimated Gmail quota units, report staleness, Undo availability/expiry and static safety-audit statements. Sender-group outcomes must separate successfully resolved groups with candidates, successfully resolved groups with zero safe candidates and failed groups. Zero-safe groups are not failure reasons. Undo diagnostics separately report untrash requests, exceptional fallback verification reads, retries, observed and expected Undo units, cleanup units and full observed lifecycle units. Show `6,000 units/user/minute` only as a reference budget; do not claim knowledge of Google's current quota-window state. Diagnostics must not render in production and must never include Gmail IDs, conversation identifiers, cleanup job IDs, raw Subjects or headers, credentials or authorization codes, Gmail search queries or provider response bodies.

The optimized non-mutating 100-message safety path is validated for one and multiple contributing senders. Keep the hard maximum at 100. Even with response-based Undo verification, immediate repeated 100-message cleanup operations can exceed the per-user minute budget. Before repeated, 1,000-message or unrestricted cleanup, implement and validate deliberate quota-aware pacing. Do not remove the proven per-message post-batch Trash verification in the controlled 100-message path.

Example:

> Cleaning inbox...
>
> **7,482 / 12,481**
>
> Moving LinkedIn notifications to Trash...

If a subset fails:

> 12,441 cleaned  
> 40 could not be moved

Then allow:

**Retry 40**

---

# 27. Cleanup Success Screen

Example:

# 12,481 emails moved to Trash

They're still recoverable in Gmail Trash.

Your inbox:

**38,217 → 25,736 emails**

Removed:

- 7,421 promotions
- 2,801 social notifications
- 1,742 newsletters
- 517 other automated emails

Potential storage recovered:

**2.4 GB**

when accurate.

Then:

### Your inbox is still connected

Buttons:

**Disconnect Gmail**

**Keep connected**

The product should intentionally make disconnection obvious rather than burying it in Settings.

---

# 28. Disconnect Flow

The product has two distinct confirmed actions.

### Disconnect Gmail

Normal Disconnect means: stop Organizinbox from having access to this inbox. It should:

1. clear stale OAuth state
2. destroy the encrypted access token and encrypted refresh token held by Organizinbox
3. clear token expiry and mark the local ProviderConnection disconnected
4. invalidate the Organizinbox application session
5. remove per-message scan metadata and the transient Inbox Report
6. remove cleanup queues
7. retain only legally/accounting-required purchase/account records
8. optionally retain anonymous aggregate product analytics only if the user consented and the data cannot reasonably identify their mailbox

Normal Disconnect must not call the provider revocation endpoint. After it completes, Organizinbox possesses no usable Gmail credential and cannot access the inbox. Google may still list Organizinbox in the user's connected-app permissions. The user can immediately begin a fresh OAuth flow without an application-added delay or token reuse.

### Remove Google authorization

While Gmail is still connected, Account should offer a separate, lower-priority advanced/security action that asks Google to remove Organizinbox from the user's connected apps. It must require its own confirmation, prefer the stored refresh token for revocation and fall back to the access token, record only safe status/success diagnostics, and then perform all normal local credential and transient-state destruction regardless of whether Google confirms revocation. A GET request, link prefetch, or cross-origin request must never trigger it.

Once normal Disconnect has destroyed the local tokens, Organizinbox must not retain or recover a credential merely to preserve later revocation capability. A disconnected user who wants deeper removal should instead receive a clearly labeled external link to the current Google Account connected-app management page.

Then show:

> **Disconnected**
>
> We no longer have access to your inbox.

This is what makes:

> **Connect. Clean. Disconnect.**

a product behavior rather than marketing fluff.

---

# 29. Privacy Architecture

Privacy is part of the product, not merely a legal page.

MVP requirements:

### Never sell inbox-derived data.

### Never use inbox data for advertising profiles.

### Never use inbox data for third-party market research.

### Never train AI models on user email data.

### Do not retrieve bodies during normal scans.

### Do not retrieve attachments.

### Process Subject lines transiently only to derive protection signals, then discard the raw text.

### Do not send inbox metadata to external LLM APIs in MVP.

### Encrypt OAuth credentials/tokens at rest.

### Do not write access tokens to application logs.

### Do not write sender addresses into generic analytics systems.

### Do not place email metadata in client-side analytics events.

### Do not persist individual mailbox data in the application database.

### Treat the scan worker as a temporary processor.

Mailbox metadata may temporarily pass through Organizinbox infrastructure because this is a web-based scan architecture. Do not claim that the mailbox never touches Organizinbox servers or that everything happens locally in the browser.

The accurate privacy claim is:

> **We don't store your inbox.**

Organizinbox temporarily processes only the mailbox metadata required to build the Inbox Report and perform cleanup the user approves. Subject lines are temporarily decoded only to protect messages that may be important and are not stored. Individual mailbox data is not saved to the application database and is discarded after processing.

Mailbox-derived data must never be used for:

- advertising
- ad targeting
- data brokerage
- sale to third parties
- market research
- user profiling unrelated to Organizinbox
- third-party analytics
- AI model training
- generalized machine-learning datasets
- unrelated product development

Mailbox information exists only for the immediate user-requested purpose: analyze that user's inbox and perform cleanup they approve. Any future aggregated research program such as an Inbox Clutter Index requires a separate design, explicit privacy review, and consent decision. It is not implicitly permitted by the MVP architecture.

The research concludes that inbox access itself creates a separate purchase decision, so privacy must be conspicuous during the sales process rather than hidden in legal pages.

---

# 30. Data Retention Target

Design toward:

### Active scan

Individual mailbox records may exist transiently in scan-worker memory or bounded buffers while the active scan is running. They should be transformed into aggregate counters immediately and discarded. The production application database must not store message IDs, sender addresses, per-message dates, per-message flags, per-message labels, per-message classifications, or user-specific sender rankings.

Conversation identifiers for Sent/user-participation detection may exist only in a transient in-memory set associated with the active scan/report. They are subject to the same cleanup, expiry and disconnect lifecycle and must never be persisted or logged. Raw Subject text must be discarded immediately after deriving its typed protection signal and must not be retained in the active report.

### Completed cleanup

Destroy remaining transient mailbox processing state after completion. Do not retain a permanent Inbox Report result as a database record if it contains user-specific mailbox-derived analytics.

### Disconnect

Delete every locally stored OAuth token, clear token expiry, mark the provider connection disconnected, clear the application session and active scan/cleanup queues, and destroy remaining temporary mailbox-derived processing state. This normal action does not claim to remove the Google-side connected-app grant. The separately confirmed `Remove Google authorization` action attempts provider revocation first and then performs the same local destruction even if provider revocation fails. Retain only ordinary SaaS/account records required for identity, billing, support, fraud prevention, or legal/accounting obligations.

The final exact retention duration must be reflected accurately on `/data-access`.

---

# 31. No Hidden Privacy Claims

The public site must answer:

- What Gmail permission do we request?
- What Outlook permission do we request?
- What can those permissions technically access?
- What fields does our application actually retrieve?
- Do we retrieve subject lines?
- Do we retrieve email bodies?
- Do we retrieve attachments?
- Where is processing performed?
- What is stored?
- How long is it stored?
- Where are OAuth tokens stored?
- Are models trained on inbox data?
- Is inbox data sold?
- Is inbox data used for advertising?
- What happens when the user disconnects?
- What happens when Clean is clicked?
- How can provider access be revoked manually?

These are explicitly recommended trust questions from the research.

---

# 32. AI Usage

MVP:

**Do not require an LLM.**

Use:

- provider metadata
- native labels
- headers
- sender patterns
- message age
- read status
- frequency
- interaction history
- deterministic classification rules

Later, an ML/LLM classifier may be tested for ambiguous groups.

Any future AI implementation must not silently transmit private mailbox content to a third party.

---

# 33. Pricing Model

Pricing is a hypothesis to validate, not a permanent requirement.

Recommended initial model:

## Free Scan

$0

Includes:

- connect inbox
- complete Inbox Report
- sender analytics
- category analytics
- cleanup recommendations
- clean up to 500 selected emails

The free product needs to produce the "aha" moment.

Example:

> **We found 17,412 emails you probably don't need.**

Then sell the action.

## Full Inbox Reset

Initial experiment:

**US$9.99**

Includes:

- full cleanup for one connected inbox
- unlimited selected messages during that cleanup session
- full Inbox Report
- cleanup history for that session

Test:

$7.99  
$9.99  
$14.99

Do not assume the lowest price wins.

## Multiple Inbox Option

Potential:

**US$14.99 to $19.99**

for multiple connected mailboxes.

## Future recurring plan

Do not build at MVP.

Possible later:

> **Keep It Clean**

for recurring monitoring.

The research confirms that one-time/no-subscription messaging is commercially relevant but already exists among competitors, so it should support the positioning rather than serve as the main moat.

---

# 34. Required Public Website Architecture

Launch with:

```text
/
├── gmail-cleaner
├── outlook-cleaner
├── bulk-delete-emails
├── delete-emails-by-sender
├── delete-old-emails
├── delete-newsletters
├── free-up-gmail-storage
├── free-up-outlook-storage
├── inbox-reset
├── pricing
├── security
├── data-access
├── privacy
├── about
├── guides
└── compare
```

The SEO report recommends building around differing search intent rather than making dozens of pages for spelling variants of the same query.

---

# 35. Homepage

Primary purpose:

**Category + diagnosis + conversion**

Suggested information hierarchy:

### Hero

**See what's clogging your inbox.**

Organizinbox finds the senders and old email taking over your inbox, then helps you clean thousands of messages safely.

Use the canonical session-aware primary CTA.

**Outlook support** links to honest coming-soon information.

### Immediate trust

- Nothing permanently deleted
- Review before cleanup
- No inbox-data selling
- Disconnect anytime

### Product visual

Show an example Inbox Report.

### How it works

1. Connect: Connect Gmail securely.
2. Scan: See what's filling your inbox.
3. Review: Check what Organizinbox recommends cleaning.
4. Clean: Move unwanted email to Trash in a few clicks.

### Biggest offenders demonstration

Example sender table.

### Safety section

"Important mail stays protected."

### Gmail + Outlook

Explain provider support.

### Privacy

Plain-language data access.

### Pricing

No hidden post-OAuth pricing.

### FAQ

Actual user questions.

### Final CTA

**See what's clogging your inbox**

---

# 36. `/gmail-cleaner`

Primary target:

**Gmail cleaner**

Secondary concepts:

- clean Gmail inbox
- Gmail cleanup
- declutter Gmail
- bulk Gmail cleanup

Must be genuinely Gmail-specific.

Explain:

- Gmail Promotions
- Social
- Updates
- sender analysis
- age filters
- unread analysis
- Gmail storage
- Gmail Trash
- Google permissions
- what the product does differently from normal Gmail search

CTA:

**Connect Gmail**

Do not create separate near-duplicate pages for every wording variation.

---

# 37. `/outlook-cleaner`

Primary target:

**Outlook cleaner**

Include:

- Outlook.com
- Hotmail
- Microsoft 365 where supported

Explain clearly:

- Sweep
- Clean Up
- Deleted Items
- native Outlook limitations
- sender analytics
- inbox diagnosis
- Microsoft permissions

Key differentiation:

> Outlook's tools are good when you know what needs cleaning.
>
> We show you what is causing the clutter first.

---

# 38. `/delete-emails-by-sender`

This is one of the highest-priority landing pages.

Primary message:

> **Find who's filling your inbox.**

Show an interactive-looking example:

```text
LinkedIn        2,482
Facebook        1,912
Amazon          1,481
Uber              983
Netflix           472
```

Explain:

- Gmail/Outlook native way
- manual problem
- our automatic sender ranking
- safety controls
- bulk Trash

CTA:

**Find my biggest senders**

The SEO research rates sender cleanup as a very high opportunity and specifically identifies "who sends me the most emails?" as a hidden commercial query.

---

# 39. Storage Pages

Build:

`/free-up-gmail-storage`

and

`/free-up-outlook-storage`

These are not generic product pages.

They target the emergency:

> **My mailbox is full.**

Show:

- current provider storage behavior
- what kinds of email consume space
- manual cleanup
- how to identify large contributors
- how our product helps

Never claim exact storage recovery if the provider's API does not support reliable attribution.

---

# 40. Security Pages

`/security`

High-level security practices.

`/data-access`

Exact technical disclosure.

These pages MUST ship with MVP.

Do not treat them as post-launch legal chores.

The report explicitly classifies both security and data-access pages as high-opportunity commercial pages.

---

# 41. Launch Guide Program

Build the product first, but launch with a useful initial guide cluster.

Priority articles:

1. How to Delete Thousands of Emails in Gmail
2. How to Bulk Delete Emails in Gmail
3. How to Delete All Emails From One Sender in Gmail
4. How to Delete All Promotions in Gmail
5. How to Delete Gmail Social Emails in Bulk
6. How to Delete Gmail Updates in Bulk
7. Gmail Storage Full: What Counts and How to Free Space
8. How to Find What's Taking Up Gmail Storage
9. How to Find the Largest Emails in Gmail
10. How to Clean Gmail Without Deleting Important Email
11. How to Delete Old Unread Gmail Messages
12. I Have 20,000+ Emails: A Safe Gmail Recovery Plan
13. How to Bulk Delete Emails in Outlook
14. How to Delete All Emails From One Sender in Outlook
15. Outlook Mailbox Full: How to Free Up Space
16. Outlook Sweep vs Clean Up vs Rules

These topics are the report's highest-priority initial content program.

Each guide should:

1. answer the question directly
2. document the native Gmail/Outlook solution
3. use official provider sources
4. explain limitations honestly
5. show screenshots
6. explain safety considerations
7. offer our product as the shortcut

Never write:

> "The only way is to use our product."

if Gmail or Outlook can perform the task manually.

---

# 42. SEO Funnel

Primary funnel:

```text
Specific painful query
        ↓
Useful manual solution
        ↓
Explain limitations
        ↓
Show easier product workflow
        ↓
Trust/safety proof
        ↓
Connect inbox
        ↓
Free scan
        ↓
Inbox Report
        ↓
Paid cleanup
```

This is preferable to depending on:

```text
email cleaner
   ↓
homepage
   ↓
buy
```

The report identifies the task-first funnel as strategically stronger than relying on the generic "email cleaner" category.

---

# 43. Comparison Pages

Do not launch a huge comparison farm immediately.

After product proof exists, build:

```text
/compare/clean-email-alternative
/compare/mailstrom-alternative
/compare/unroll-me-alternative
/compare/leave-me-alone-alternative
/compare/outlook-sweep
/compare/gmail-native-cleanup
/best-email-cleaners-large-inboxes
```

All comparisons must have transparent methodology.

Do not create fake "independent reviews" where our product automatically wins every category.

---

# 44. First-Party Research

Once enough users exist, create an anonymized:

# Inbox Clutter Index

Potential metrics:

- median inbox size
- median unread count
- percentage of mail generated by top 10 senders
- most common high-volume sender categories
- median age of unread messages
- percentage of email classified as automated
- Gmail versus Outlook differences
- average number of cleanup groups selected
- average number of emails cleaned
- average percentage of mailbox users choose to remove

Only collect/publish this data after a separate future privacy design, explicit consent decision, and strong aggregation. The MVP architecture does not implicitly permit retaining mailbox-derived data for research.

This can become a major SEO, PR and AI-search asset.

The report specifically recommends original datasets because current Google and Bing guidance favours distinctive information and evidence over commodity SEO content.

---

# 45. Technical Web Architecture

Recommended:

- Next.js App Router
- TypeScript
- relational database
- provider adapters
- durable scan/cleanup orchestration
- separate long-running scan worker abstraction
- Stripe for payments
- server-side OAuth handling
- encrypted token storage
- transient streaming mailbox processing

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

Public marketing pages:

primarily static/server rendered.

Authenticated application:

client interactivity where required.

Do not require client-side JavaScript to render important SEO text.

---

# 46. Long-Running Job Architecture

A 50,000-message mailbox cannot depend on one fragile server request.

Scanning and cleanup require independent durable jobs and worker execution that is not inseparably coupled to short-lived Next.js request handlers.

Next.js should remain the product UI, marketing site, account surface, and API/control layer where appropriate. Long-running scan execution should sit behind a worker abstraction. The worker may later run on infrastructure suitable for persistent provider connections, such as Cloud Run, Fly.io, Railway, Render, ECS, or another appropriate container/worker service. Do not choose or provision a production worker host until benchmark and integration work justify it.

System must support:

```text
scan requested
  -> create independent scan job
  -> worker connects to provider
  -> build transient Sent/user-participation conversation index
  -> fetch allowlisted metadata batch/stream
  -> normalize transient record
  -> apply message protections and metadata-only eligibility rules
  -> update in-memory aggregates
  -> discard individual record
  -> emit progress/report snapshot
  -> repeat until scan complete
```

If execution stops:

**resume at last checkpoint.**

Same principle for cleanup.

Multiple users must be able to scan simultaneously. A 3-minute scan for User A must not force User B to wait 3 minutes before their scan starts. Do not build a single global serial scan loop. At scale, worker concurrency should be horizontally scalable subject to provider limits, worker capacity, and per-account constraints.

---

# 47. Minimal Database Model

Conceptual entities:

```text
User
- id
- account identity fields required for login
- createdAt
- updatedAt

ProviderConnection
- id
- userId
- provider
- encryptedAccessToken
- encryptedRefreshToken
- tokenExpiresAt
- scope
- connection state
- createdAt
- disconnectedAt

ScanJob
- id
- userId
- providerConnectionId
- provider
- status
- startedAt
- completedAt
- failureCode
- high-level progress state only if it contains no mailbox-derived identifiers or report analytics

CleanupJob
- id
- scanJobId
- status
- startedAt
- completedAt
- failureCode
- high-level progress state only if it contains no mailbox-derived identifiers or report analytics

Purchase / Entitlement
- userId
- provider where appropriate
- stripeReference
- plan
- amount
- currency
- timestamps
```

Do not persist:

- email bodies
- raw email subjects
- attachment data or contents
- individual sender addresses
- individual message IDs
- raw Gmail messages
- raw Microsoft messages
- IMAP responses
- Graph responses
- Gmail labels associated with individual messages
- individual message dates
- individual message sizes
- individual message flags
- per-message classifications
- user-specific sender rankings
- user-specific category analytics
- permanent Inbox Report results

Message-level metadata, sender aggregates, category analytics, cleanup group membership, and provider message identifiers are transient production processing data. They may exist in bounded worker memory, temporary queues, or the active client session only as required to build the current report or perform approved cleanup, and they must not become persistent Prisma models.

---

# 48. Analytics

Product analytics must never contain email content or sender addresses.

Track:

```text
landing_page_view
provider_connect_started
provider_connect_completed
scan_started
scan_progress
scan_completed
inbox_report_viewed
sender_group_opened
cleanup_group_selected
cleanup_group_deselected
checkout_started
purchase_completed
cleanup_started
cleanup_completed
disconnect_completed
```

Important funnel metrics:

### Acquisition

visitor → connect

### Activation

connect → scan complete

### Value recognition

scan complete → Inbox Report viewed

### Conversion

Inbox Report → purchase

### Completion

purchase → cleanup completed

### Trust

cleanup completed → disconnect

Segment by:

- Gmail/Outlook
- approximate inbox-size bucket
- landing-page intent
- free vs paid
- search query/page where available

---

# 49. SEO Technical Requirements

At launch:

- canonical URLs
- XML sitemap
- robots.txt
- Open Graph metadata
- unique title/description per indexable page
- SoftwareApplication structured data
- Organization structured data
- WebSite structured data
- BreadcrumbList where appropriate
- Article structured data on guides
- descriptive crawlable internal links
- server-rendered public copy
- responsive design
- strong Core Web Vitals
- Google Search Console
- Bing Webmaster Tools
- IndexNow
- OAI-SearchBot allowed
- PerplexityBot allowed

Do not depend on `llms.txt` for ranking.

Do not manufacture hundreds of exact-query pages.

The report specifically distinguishes crawler accessibility, structured information and original content as supported AI-search practices while rejecting artificial content chunking, massive exact-prompt page creation and `llms.txt` hype as ranking strategies.

---

# 50. Indexing Rules

Index:

- marketing pages
- provider pages
- use-case pages
- pricing
- security
- data access
- About
- guides
- comparisons
- public methodology
- research
- changelog

Do not index:

- login
- OAuth callbacks
- dashboard
- scan result URLs
- cleanup result URLs
- settings
- billing portal
- account pages
- private analytics
- user-specific data

Authenticated content must be protected by authentication, not merely robots.txt.

---

# 51. AI Search Optimization

Design public documentation so an answer engine can confidently answer factual questions such as:

> Does this support Outlook?

> Does it permanently delete mail?

> Does it read email bodies?

> How much does it cost?

> Does it require a subscription?

> Can I disconnect it afterward?

> What Gmail permissions does it use?

> What Outlook permissions does it use?

Create stable pages containing clear answers.

Avoid vague marketing language where a factual answer is possible.

---

# 52. Public Product Matrix

Create a crawlable product-facts page or section containing:

```text
Providers:
Gmail
Outlook.com
Hotmail
Microsoft 365 where allowed

Permanent deletion:
No

Trash-first cleanup:
Yes

Review before cleanup:
Yes

Email body retrieval:
No during normal scan

Attachment retrieval:
No

Subscription required:
No, if final pricing remains one-time

Disconnect available:
Yes
```

Only publish facts verified by the implemented product.

This makes product attributes much easier for search engines and AI systems to retrieve accurately.

---

# 53. Performance Requirements

Architecture should be designed for:

### Small

1,000 emails

### Normal target

10,000 to 30,000

### Large

50,000+

Target for Gmail:

**approximately 3-5 minutes for a 50,000-message mailbox**

This is an unverified engineering target and must not be stated publicly as achieved until benchmarked against real Gmail IMAP/XOAUTH2 scans.

### Stress target

100,000+

Do not advertise a tested maximum until benchmarking is complete.

Before launch, test at least synthetic/controlled mailbox sizes:

- 5k
- 10k
- 25k
- 50k
- 100k

Measure:

- scan duration
- connection time
- metadata bytes transferred
- failures
- memory usage
- CPU use
- provider throttling
- retry behavior
- aggregate generation time
- Sent/conversation-index time
- protection-classification time
- peak transient participation-set size
- safe batch sizes
- worker concurrency behavior
- database writes, which should not include mailbox-derived message or sender data
- cleanup duration

The architecture should support many simultaneous users. Worker concurrency and scaling should be designed separately from individual mailbox scanning, and one user's long scan must not block another user's scan.

Publish trustworthy performance figures only after testing.

Before production integration is finalized, run a Gmail IMAP performance spike against approximately 5k, 10k, 25k, 50k, and ideally 100k messages. If IMAP cannot meet the target, reassess the architecture and update this specification before changing implementation direction.

---

# 54. Error States

Must explicitly handle:

- user denies OAuth
- expired access token
- refresh-token failure
- Microsoft admin policy denial
- Google OAuth verification restriction
- provider throttling
- scan interrupted
- provider network error
- malformed sender
- missing metadata
- message disappears between scan and cleanup
- message already moved/deleted
- partial cleanup
- payment succeeds but cleanup job fails

Every destructive operation must be safely retryable.

---

# 55. Accessibility

Minimum:

- keyboard navigation
- semantic HTML
- visible focus states
- accessible confirmation dialogs
- screen-reader labels
- non-color-only confidence indicators
- adequate contrast
- responsive layout

A user must be able to understand:

**Very High / High / Review / Keep**

without relying solely on color.

---

# 56. Mobile Strategy

Public marketing pages:

fully responsive from launch.

Authenticated cleanup application:

responsive, but desktop-first.

Do not invest in native iOS/Android applications in MVP.

Large-inbox review naturally benefits from desktop space.

---

# 57. MVP Screens

Build these screens:

1. Homepage
2. Google/Microsoft selection
3. Pre-OAuth permissions explanation
4. OAuth callback/loading
5. Scan progress
6. Inbox Report
7. Biggest Senders
8. Categories
9. Old Email
10. Unread Email
11. Group detail
12. Protected Mail explanation
13. Cleanup review
14. Purchase/paywall
15. Cleanup progress
16. Cleanup success
17. Connection/disconnect
18. Account/settings
19. Pricing
20. Security
21. Data Access
22. Privacy
23. Provider landing pages
24. SEO/use-case pages
25. Guide template

---

# 58. MVP Navigation

Organizinbox should feel like one intentionally designed product with two route contexts:

- public website
- application

Public routes teach, build trust, attract search traffic, and convert users. Application routes guide a connected user through cleaning an inbox. The two contexts coexist.

Route decides shell. Session decides CTA/state inside that shell. Login or provider state must never replace the public website.

Do not model the user journey as:

```text
marketing site -> separate cleanup utility -> return to marketing site -> reconnect
```

Model it as:

```text
public entry point -> authenticated Organizinbox session -> connected provider -> scan/report/cleanup workflow -> explicit disconnect
```

Persistent Organizinbox/provider state may contain:

- User
- secure application session
- ProviderConnection
- encrypted provider tokens where required
- provider type
- encrypted connected-account identity
- safe connection timestamps/status
- purchases/entitlements later

Persistent state must not contain:

- message lists
- sender rankings
- Inbox Report contents
- Gmail message IDs
- raw subjects
- bodies
- attachments
- mailbox-derived report analytics

The provider connection may persist. Inbox data and reports remain transient.

Final public information architecture:

```text
HOME
/

PRODUCT / PROVIDERS
/gmail-cleaner
/outlook-cleaner

GUIDES / CLEANUP INTENTS
/guides
/bulk-delete-emails
/delete-emails-by-sender
/delete-old-emails
/delete-newsletters
/free-up-gmail-storage
/free-up-outlook-storage
/inbox-reset

COMMERCIAL
/pricing

TRUST
/security
/data-access
/privacy

COMPANY
/about

CONNECT
/connect/google
/connect/google/error
/connect/microsoft
```

Connect pages are noindex utility/conversion pages, not SEO destinations.

Final application information architecture:

```text
/app
/app/scan
/app/report
/app/cleanup
/app/account
/app/help
/app/security
/app/data-access
/app/privacy
/app/dev/gmail-benchmark
```

Legacy routes may remain as redirects and must not appear in current navigation:

```text
/app/settings
/app/senders
/app/categories
/app/old-mail
```

OAuth routes:

```text
/api/oauth/google/start
/api/oauth/google/callback
```

The public homepage always renders the public Organizinbox marketing homepage. Provider connection or session state must never make `/` become `/app`, replace the marketing page with an application-state screen, or automatically redirect a connected user away from `/`. Connected users may still browse all public marketing pages normally. Public pages may be session-aware, but they remain public pages: the hero, marketing sections, trust content, product explanation, pricing preview, guide links, and footer remain the normal public landing experience while the primary CTA adapts to the current session.

Route context decides the shell:

- `/app/*` routes use the app shell
- public routes use the marketing shell

Public marketing pages use the marketing shell. An active Organizinbox workflow uses the app shell.

Session state decides content and CTA within that shell. Authentication or provider connection state must not decide that `/`, `/pricing`, `/security`, `/data-access`, `/privacy`, `/about`, `/guides`, `/gmail-cleaner`, or `/outlook-cleaner` should render the app shell.

Brand navigation must use one clickable Organizinbox brand link that includes both the logo icon and the wordmark. The Organizinbox brand/logo link always navigates to `/` everywhere, including the public marketing header, authenticated app header, active Inbox Report, cleanup review, Account, Help, Security, Data Access, and Privacy. The public homepage is session-aware, so connected users who click the brand can return to the app or active report through the homepage CTA without the brand linking directly to `/app`.

Public header final visible navigation:

```text
Organizinbox -> /
Gmail -> /gmail-cleaner
Outlook -> /outlook-cleaner
Guides -> /guides
Pricing -> /pricing
Security -> /security
[Primary CTA] -> session-aware
```

Remove redundant homepage-anchor navigation such as Product or How It Works from the global header when it crowds the header. The homepage may still contain Product and How It Works sections and internal anchor links within the page.

Public mobile navigation must keep the brand visible and provide an accessible menu containing Gmail, Outlook, Guides, Pricing, Security, and the session-aware primary CTA. The menu must be keyboard accessible, provide clear open/close controls, preserve visible focus states, close after ordinary route choices, and avoid horizontal overflow.

Public pages must use one canonical primary CTA resolver across the public header, homepage hero, provider pages, cleanup-intent SEO pages, pricing, trust/company pages where a product CTA is appropriate, and final CTA sections. Required public CTA states:

```text
No provider:
  generic/Gmail page -> Clean my inbox or Clean my Gmail -> /connect/google

Connected + active report:
  Return to Inbox Report -> /app/report

Connected + no report:
  Scan my inbox -> /app/scan

Connected + expired/stale report:
  Scan my inbox -> /app/scan

Needs reconnect:
  Reconnect Gmail -> /connect/google
```

Do not restart OAuth for a valid existing provider connection.

Marketing page configuration should explicitly describe provider/content intent, related pages, and content clusters rather than inferring everything from URL strings. Related links should connect provider, cleanup, storage, trust, and company pages naturally without keyword stuffing.

Outlook is not yet a working production provider. Public Outlook pages may remain indexable, but while Outlook support is unavailable they must show an honest status such as `Outlook support is coming soon.` They must not send an Outlook-intent CTA to `/connect/google` while pretending it is Outlook, expose a functional-looking Microsoft connection, or expose fixture-report shortcuts as normal product behavior. Useful alternatives may include learning how Organizinbox works, reading related Outlook information, and an explicitly labeled `Clean Gmail instead` secondary action.

Provider availability is an explicit product boundary. Gmail is available. Microsoft/Outlook is coming soon. Do not decide Outlook availability from whether development OAuth credentials happen to exist.

The public homepage should provide obvious paths to Gmail Cleaner, Outlook Cleaner, Guides, Pricing, Security, and the primary app CTA. It should include a concise Popular inbox cleanup guides section linking to Delete old emails, Delete emails by sender, Delete newsletters, Bulk delete emails, Free up Gmail storage, and Inbox reset.

`/guides` is a real resource hub. It should visibly organize the existing cleanup-intent pages into categories such as Cleanup, Storage, Workflow, and Providers. Each item should have a title, short useful description, and clear link. The page includes the session-aware product CTA and remains indexable.

SEO/marketing pages should form a cohesive browsing and conversion system with clear page content, provider/session-aware primary CTA, trust/data-access secondary path where relevant, related content, a final product CTA, and the normal marketing footer.

Public footer should act as a manageable site map:

```text
Product: Gmail Cleaner, Outlook Cleaner, Pricing, How it works -> /#how-it-works
Guides: Guides, Delete old emails, Delete by sender, Delete newsletters, Free up Gmail storage, Inbox reset
Trust: Security, Data Access, Privacy
Company: About
```

The public brand/logo may link Home. A separate Home text link is not required if the logo clearly provides it. The footer Home link always navigates to `/`.

Connect pages must use the full marketing shell and remain noindex:

```text
/connect/google
/connect/google/error
/connect/microsoft
```

The Google connect page uses the concise `Connect Gmail` hierarchy from the Product Copy System. It explains that access is used to scan the inbox and move approved messages to Trash, lists the concrete access limits, links to Data Access for detail, and uses `Connect Gmail` plus `Back to homepage`. If Gmail is already connected, it must avoid OAuth and offer the natural app continuation: Return to Inbox Report or Scan my inbox depending on state. Google OAuth error recovery should use plain language, retain precise internal failure classification, and offer Try connecting Gmail again plus Back to homepage.

After a genuinely new or reconnected Google authorization succeeds, the user should enter the natural workflow at `/app/scan`.

Normal production/public navigation must not send users into an unfinished Microsoft OAuth flow. If Microsoft development OAuth remains available, it must be behind an explicit development feature flag or route boundary. Do not delete the Microsoft provider architecture and do not implement Outlook in this pass.

Pricing remains public and indexable. Until Stripe/product purchase flow is implemented, pricing's product CTA follows the central session-aware scan/app CTA. Do not link incomplete checkout behavior from public navigation.

Authenticated app header final navigation:

```text
Organizinbox -> /
Gmail connected badge when applicable
Help -> /app/help
Account -> /app/account
```

Do not put Senders, Categories, Old Mail, Cleanup, or public marketing navigation in the app header.

The authenticated app uses a stable, simple global header and footer across `/app`, scan progress, Inbox Report, cleanup review, cleanup progress, success, and account/settings surfaces.

The app footer is contextual support navigation:

```text
Home -> /
Help -> /app/help
Security -> /app/security
Data Access -> /app/data-access
Privacy -> /app/privacy
```

All trust/help links except Home preserve the app shell. Visiting `/` from the app through either the brand link or footer Home link must not clear the provider connection, clear transient reports, clear cleanup jobs, shorten report TTL unexpectedly, trigger OAuth, trigger a rescan, or force fixture fallback.

App-context support/account routes exist for:

```text
/app/help
/app/security
/app/data-access
/app/privacy
/app/account
```

These may reuse the same underlying Security, Data Access, Privacy, or Help content as public pages, but they must render inside the app shell and provide a clear path back to the active Inbox Report when a valid transient report exists. Otherwise, they should provide Back to Organizinbox -> `/app`. Contextual Back actions use the shared visible secondary-action treatment: outlined or equivalent secondary-button styling, adequate padding, visible hover/focus states, mobile touch-target sizing, and destination-specific labels. Opening Help, Security, Account, Data Access, or Privacy must not clear the transient report, trigger a rescan, switch report source, or create fixture data.

`/app` is the canonical state-aware application home. It must resolve the current Organizinbox session, current ProviderConnection, and active transient report if one exists.

`/app` states:

```text
No provider connected:
  primary Connect Gmail
  show Outlook support as coming soon

Gmail connected, no active report:
  primary Scan my inbox
  secondary Account

Gmail connected, active report:
  primary Open Inbox Report
  secondary Rescan

Transient report expired or stale, Gmail still connected:
  primary Scan again
  secondary Account

Needs reconnect:
  primary Reconnect Gmail
```

Do not ask a connected Gmail user to authorize Google again for ordinary navigation, browser refresh, homepage visits, rescan, opening the report, account/help/security/data-access/privacy pages, or cleanup review. OAuth should start only when no valid provider connection exists, credentials are genuinely invalid, the user intentionally chooses another account, or reauthorization is explicitly required.

Do not treat report-specific analysis views as global application destinations. `Senders`, `Categories`, and `Old Mail` live inside the current Inbox Report experience as internal report navigation. `Cleanup` is a next step from a specific report, not a persistent global tab.

The Inbox Report is the parent analysis workspace:

```text
Your Inbox Report

[Overview] [Senders] [Categories] [Old Mail]

active report view

[Review cleanup]
```

Report navigation back actions should say `Back to Organizinbox`, go to `/app`, and use the shared visible secondary-action treatment rather than a tiny plain text link. Scan uses the same destination and label. Cleanup uses `Back to Inbox Report` -> `/app/report`. Connect and Google error recovery use `Back to homepage` -> `/`. Stale reports should clearly offer `Rescan inbox` -> `/app/scan`.

A cleanup review must be derived from the same active report source that produced it, for example `fixture`, `gmail-live`, or `microsoft-live`. A live Gmail report must never open a fixture cleanup review, and fixture data must never be used as fallback data when fixture mode is disabled.

Cleanup completion navigation must be explicit. After a successful or partial cleanup, show `Rescan inbox` -> `/app/scan` as the primary next action and `Back to Inbox Report` -> `/app/report` as the secondary action. If Undo is available, keep it clearly available. If the old report is stale, make that explicit.

If transient live report state expires, show a clear expired-report state and route the user to scan again while preserving the provider connection. Do not silently substitute fixture data and do not send a still-connected user back through OAuth.

Normal scan UX lives at `/app/scan`. If Gmail is connected, `/app/scan` should show a simple product flow: ready to scan, scanning progress, then report ready. Scan and rescan enter a visible pending state immediately, disable duplicate submission and use the same truthful operation-status treatment as cleanup. The server should reuse the same session's active scan rather than start duplicate mailbox work when concurrent start requests arrive. A failed start or scan exits pending state into a usable error/retry state. Batch sizes, benchmark limits, and other developer controls remain under `/app/dev/gmail-benchmark`.

Settings/account may remain a separate global destination when it represents account or connection state rather than report-specific filters. Account state must be resolved from persistent SaaS provider-connection/session state, not inferred from fixture mode or from the mere presence of a transient report. Fixture mode must be clearly labeled as development fixture state and must never be presented as a real connected inbox.

`/app/dev/gmail-benchmark` is development-only and must remain outside normal product navigation. If benchmark mode is disabled, provide a safe route out: Back to Organizinbox -> `/app`.

`Disconnect Gmail` is the ordinary end of Organizinbox access. It is an application mutation/action, not a navigable destination or API page. The user must confirm it before the app destroys encrypted access and refresh tokens, clears token expiry, marks the ProviderConnection disconnected, clears the application session, clears transient report/cleanup jobs, and clears stale OAuth state. It must not call Google's revoke endpoint. Successful disconnect returns the user to `/`, never raw JSON. A GET request must not perform destructive work and should return 405 Method Not Allowed or redirect safely. Ordinary navigation, link prefetch, public homepage visits, and browser back/forward must not disconnect the user.

`Remove Google authorization` is a distinct lower-priority Account action offered while Gmail is connected. Its separate confirmation explains that it disconnects Gmail locally and asks Google to remove Organizinbox from connected apps, and that Google may take a short time to finish. The server action attempts remote revocation using a stored credential, records non-sensitive success/status diagnostics, then always performs the same local destruction as normal Disconnect. It must be POST-only, same-origin protected, and redirect to `/`. Normal users must not see provider HTTP details. If remote removal cannot be confirmed, local disconnect still completes; a simple non-technical follow-up may explain that Google-side removal was not confirmed.

After local Disconnect, Account or Help may link users to `https://myaccount.google.com/connections` with clear external-destination labeling so they can manage Organizinbox directly in Google Account. Do not preserve a token for later revocation. The temporary local-disconnect experiment, feature flag, route, and development Account control are removed now that local credential destruction is the normal production behavior.

Public marketing/SEO pages, provider pages, cleanup intent pages, pricing, trust pages, About, and Guides are indexable. `/connect/google`, `/connect/google/error`, `/connect/microsoft`, `/app/*`, development routes, API routes, scan result URLs, cleanup result URLs, and account pages are noindex or excluded from the sitemap as appropriate.

Transient reports must use a report-store abstraction. The development implementation may be in-memory with a 30-60 minute inactivity TTL. The store should support `get`, `set`, `touch`, `delete`, and active-report checks so production can later replace it with suitable ephemeral worker/cache infrastructure without storing reports in Prisma.

---

# 59. Visual Product Direction

The interface should feel:

- calm
- trustworthy
- utility-focused
- clean
- slightly premium
- non-technical
- not playful
- not hacker-like
- not neon
- not overloaded with AI imagery

The emotional goal is:

> **"Finally, someone made this manageable."**

not:

> "Here is another complicated productivity dashboard."

---

# 60. Out of Scope for Initial Codex Build

Explicitly exclude:

- mobile apps
- Yahoo
- iCloud
- IMAP
- permanent delete
- sending email
- reading full messages
- attachment inspection
- LLM classification
- email drafting
- calendar
- inbox client
- daily digest
- automatic ongoing deletion
- autonomous deletion without approval
- enterprise administrator features
- complex subscription management
- AI assistant/chat interface

These can be evaluated after actual product usage.

---

# 61. Phase 2 Candidates

After MVP validation:

### Unsubscribe

Allow users to unsubscribe from selected senders after historical cleanup.

### Keep It Clean

Optional recurring cleanup.

### Scheduled scans

Weekly/monthly cleanup suggestions.

### Additional providers

- iCloud
- Yahoo
- IMAP

### Smarter classification

Privacy-preserving local or server-side models.

### Multiple inboxes

Household/professional plans.

### Storage intelligence

More detailed size analysis where provider APIs allow it.

---

# 62. Phase 3 Defensibility

Potential moat:

## Inbox Clutter Dataset

Aggregated privacy-preserving data about inbox composition.

## Classification improvements

Learn which sender/category combinations users usually keep/remove without storing personal message contents.

## Provider-specific knowledge

Excellent Gmail and Outlook cleanup logic.

## Trust reputation

Become known specifically as the cleaner that does not recklessly delete mail.

## Search authority

Own specific high-intent workflows rather than generic productivity content.

---

# 63. Launch Acceptance Criteria

The MVP is not launch-ready until:

### Gmail

- real Gmail OAuth works
- production verification requirements understood
- scan works
- 25k+ mailbox tested
- Trash operation works
- partial failures recover
- disconnect works

### Outlook

- personal Microsoft account works
- Outlook.com/Hotmail tested
- supported Microsoft 365 account tested
- scan works
- Deleted Items operation works
- partial failures recover
- disconnect works

### Safety

- permanent delete is impossible from product UI
- recent messages protected
- flagged/starred/important protection tested
- user can deselect any recommendation
- confidence reasons visible
- cleanup confirmation explicit

### Privacy

- bodies not retrieved during standard scan
- attachments not retrieved
- Subject lines processed temporarily for protection only and not stored
- inbox metadata absent from analytics
- tokens encrypted
- sensitive logging reviewed
- retention job tested
- disconnect deletes mailbox-derived data as promised

### Scale

- 5k tested
- 10k tested
- 25k tested
- 50k tested
- attempt 100k stress test

### Billing

- free scan works
- free cleanup allowance enforced
- Stripe checkout works
- paid entitlement works
- payment failure handled

### SEO

- homepage
- Gmail page
- Outlook page
- sender page
- bulk-delete page
- Gmail storage page
- Outlook storage page
- security
- data access
- privacy
- pricing
- first launch guides
- sitemap
- schema
- crawler configuration
- Search Console
- Bing Webmaster Tools

---

# 64. Product Success Criteria

Early evidence that the idea works:

### Product

Users successfully connect mailboxes.

Users allow scans to finish.

Users inspect the Inbox Report.

Users select recommended cleanup groups.

Users pay after seeing the scan.

Users successfully clean thousands of messages.

Very few users restore selected mail because the recommendation was unsafe.

### Business

Free scan → paid cleanup conversion is viable.

CAC from SEO/community channels makes sense relative to one-time purchase price.

Support burden does not overwhelm one-time revenue.

### Search

Pages begin getting impressions for queries such as:

- delete thousands of emails
- delete all emails from sender
- Gmail cleaner
- Gmail storage full
- clean Gmail
- bulk delete Outlook
- Outlook mailbox full
- clean inbox without deleting important emails

---

# 65. North-Star Product Metric

Do not optimize for:

**emails deleted**

alone.

Optimize for something closer to:

> **Successfully cleaned inboxes without regretted removals.**

Supporting metrics:

- messages safely moved to Trash
- percentage reduction in clutter
- cleanup completion rate
- recommendation acceptance rate
- recommendation reversal rate
- support tickets involving accidental cleanup
- disconnect completion
- user-rated confidence after cleanup

---

# 66. Core Product Rule

When forced to choose between:

**cleaning more email**

and

**making the user confident nothing important will be lost**

choose confidence.

The product is dealing with years of a person's private communication.

Trust is part of the functionality.

---

# 67. Final MVP Thesis

Do not build:

> "An AI that decides which emails are junk."

Build:

> **A tool that analyzes a huge Gmail or Outlook inbox, shows the user exactly what is causing the clutter, explains which groups are likely safe to remove, protects important mail, and lets the user move thousands of unwanted messages to Trash with a few deliberate decisions.**

The deletion API is not the product.

The **Inbox Report**, recommendation system, safety model, and trust architecture are the product.

That is the specification the implementation should be designed around.
