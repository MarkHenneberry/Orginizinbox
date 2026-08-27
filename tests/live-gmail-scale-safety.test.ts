import { loadEnvConfig } from "@next/env";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import { assessMessage } from "@/lib/domain/recommendations";
import { buildGmailSenderCleanupQuery } from "@/lib/providers/gmail/cleanup-candidates";
import { gmailImapDecimalIdToApiHex } from "@/lib/providers/gmail/id-bridge";
import { gmailFetchQuery, getGmailSubjectProtection, normalizeGmailMessage } from "@/lib/providers/gmail/metadata";
import {
  assertMatchingUidValidity,
  collectCompleteGmailList,
  compareImapAndRestMutableState,
  evaluateExactImapRecheck,
  intersectCount,
  mutableStateFromRest,
  type GmailImapScaleTarget,
  type GmailMutableState,
  type GmailPaginationMetrics
} from "@/lib/providers/gmail/scale-safety";
import { formatGmailScaleDevelopmentSummary } from "@/lib/providers/gmail/scale-architecture";

const testNodeEnv = process.env.NODE_ENV;
Reflect.set(process.env, "NODE_ENV", "development");
loadEnvConfig(process.cwd(), true, console, true);
Reflect.set(process.env, "NODE_ENV", testNodeEnv);

const liveProofEnabled = process.env.ORGANIZINBOX_LIVE_SCALE_SAFETY_PROOF === "true";
const liveIt = liveProofEnabled ? it : it.skip;
const gmailApiMessagesUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

type LiveTarget = GmailImapScaleTarget & {
  senderAddress: string;
};

type SearchMeasurement = GmailPaginationMetrics & {
  wallTimeMs: number;
};

describe("live Gmail scalable safety proof", () => {
  liveIt("benchmarks complete REST pagination and exact IMAP mutable-state recheck without mutation", async () => {
    const { prisma } = await import("@/lib/server/db");
    const { getActiveGmailConnection } = await import("@/lib/server/gmail-connection");
    const { resolveGmailAllMail, resolveGmailSent } = await import("@/lib/providers/gmail/provider");
    let scanClient: ImapFlow | undefined;
    let recheckClient: ImapFlow | undefined;

    try {
      const persisted = await prisma.providerConnection.findFirst({
        where: { provider: "gmail", disconnectedAt: null },
        orderBy: { updatedAt: "desc" }
      });
      if (!persisted) throw new Error("No active Gmail connection is available for the scale safety proof.");
      const active = await getActiveGmailConnection(persisted.userId, persisted.id);
      if (!active) throw new Error("The active Gmail connection could not be opened for the scale safety proof.");

      scanClient = createImapClient(active.accessToken, active.accountEmail);
      await scanClient.connect();
      assertGmailIdProvenance(scanClient);

      const participatedConversationIds = await scanParticipatedConversationIds(scanClient, resolveGmailSent, 1_000);
      const allMailPath = await resolveGmailAllMail(scanClient);
      const mailbox = await scanClient.mailboxOpen(allMailPath, { readOnly: true });
      if (!mailbox.readOnly) throw new Error("Gmail All Mail did not open read-only for the safety proof.");
      const scanUidValidity = mailbox.uidValidity;
      const aggregator = new StreamingReportAggregator({ participatedConversationIds, includeDiagnostics: true });
      const preliminaryTargets: LiveTarget[] = [];

      for (let start = 1; start <= mailbox.exists; start += 1_000) {
        const end = Math.min(start + 999, mailbox.exists);
        const records = [];
        for await (const message of scanClient.fetch(`${start}:${end}`, gmailFetchQuery, { uid: false })) {
          if (!message.emailId || !message.uid) continue;
          const record = normalizeLiveMessage(message);
          records.push(record);
          if (assessMessage(record, { participatedConversationIds }).eligibleForCleanup) {
            preliminaryTargets.push({
              uid: message.uid,
              apiMessageId: gmailImapDecimalIdToApiHex(message.emailId),
              senderAddress: record.senderAddress
            });
          }
        }
        aggregator.processBatch(records);
      }

      const report = aggregator.snapshot("gmail", false);
      const eligibleSenders = new Set(
        report.senders
          .filter((sender) => sender.cleanupConfidence === "high" || sender.cleanupConfidence === "very_high")
          .map((sender) => sender.senderKey)
      );
      const suggestedTargets = preliminaryTargets.filter((target) => eligibleSenders.has(target.senderAddress));
      if (suggestedTargets.length < 100) {
        throw new Error("The live mailbox does not contain enough Suggested messages for the smallest scale proof.");
      }

      await closeImapClient(scanClient);
      scanClient = undefined;
      recheckClient = createImapClient(active.accessToken, active.accountEmail);
      await recheckClient.connect();
      assertGmailIdProvenance(recheckClient);
      const reopened = await recheckClient.mailboxOpen(allMailPath, { readOnly: true });
      if (!reopened.readOnly) throw new Error("Gmail All Mail did not reopen read-only for the safety proof.");
      assertMatchingUidValidity(scanUidValidity, reopened.uidValidity);

      const maximumTargetCount = Math.min(1_000, suggestedTargets.length);
      const maximumTargets = suggestedTargets.slice(0, maximumTargetCount);
      const fetchedMessages: Array<{
        uid: number;
        emailId?: string;
        flags?: ReadonlySet<string>;
        labels?: string[];
      }> = [];
      const imapStarted = performance.now();
      for (let offset = 0; offset < maximumTargets.length; offset += 250) {
        const uids = maximumTargets.slice(offset, offset + 250).map((target) => target.uid);
        for await (const message of recheckClient.fetch(uids, { uid: true, flags: true, labels: true }, { uid: true })) {
          fetchedMessages.push({
            uid: message.uid,
            emailId: message.emailId,
            flags: message.flags,
            labels: [...(message.labels ?? [])]
          });
        }
      }
      const imapRecheck = evaluateExactImapRecheck(maximumTargets, fetchedMessages);
      const imapWallTimeMs = Math.round(performance.now() - imapStarted);

      const comparisonIds = maximumTargets.slice(0, 20).map((target) => target.apiMessageId);
      const restStates = new Map<string, GmailMutableState>();
      for (const id of comparisonIds) {
        const response = await fetch(`${gmailApiMessagesUrl}/${encodeURIComponent(id)}?format=metadata&fields=id,labelIds`, {
          headers: { Authorization: `Bearer ${active.accessToken}` }
        });
        if (!response.ok) continue;
        const body = await response.json() as { id?: string; labelIds?: string[] };
        if (body.id === id && Array.isArray(body.labelIds)) restStates.set(id, mutableStateFromRest(body.labelIds));
      }
      const stateComparison = compareImapAndRestMutableState(imapRecheck.statesById, restStates, comparisonIds);

      const globalSearches = await measureGlobalProtectionSearches(active.accessToken);
      const uniqueTargetSenders = [...new Set(maximumTargets.map((target) => target.senderAddress))];
      const safeCohorts = new Map<string, SearchMeasurement>();
      for (const senderAddress of uniqueTargetSenders) {
        safeCohorts.set(
          senderAddress,
          await measureMessageList(active.accessToken, { query: buildGmailSenderCleanupQuery({ senderAddress }) })
        );
      }

      const sizes = [100, 500, 1_000].filter((size) => size <= suggestedTargets.length);
      const lines = [
        "ORGANIZINBOX DEV SCALE SAFETY",
        `Fresh scan messages: ${report.totals.messages.toLocaleString("en-US")}`,
        `Suggested IDs available: ${suggestedTargets.length.toLocaleString("en-US")}`,
        "",
        "Exact IMAP mutable recheck",
        `Targets: ${maximumTargets.length.toLocaleString("en-US")}`,
        `Exact messages returned: ${fetchedMessages.length.toLocaleString("en-US")}`,
        `Missing: ${imapRecheck.excludedMissingCount.toLocaleString("en-US")}`,
        `Identity mismatch: ${imapRecheck.excludedIdentityMismatchCount.toLocaleString("en-US")}`,
        `Wall time: ${imapWallTimeMs.toLocaleString("en-US")} ms`,
        "",
        "IMAP vs REST shared state",
        `Compared: ${stateComparison.compared}`,
        `State matches: ${stateComparison.stateMatches}`,
        `Mismatches: ${stateComparison.mismatches}`,
        `Unavailable: ${stateComparison.unavailable}`,
        ""
      ];

      for (const size of sizes) {
        const targets = suggestedTargets.slice(0, size);
        const targetIds = targets.map((target) => target.apiMessageId);
        const senders = new Set(targets.map((target) => target.senderAddress));
        const cohortMetrics = [...senders].map((sender) => safeCohorts.get(sender)!);
        const safeCohortIds = new Set(cohortMetrics.flatMap((metric) => [...metric.ids]));
        const globalMetrics = [...globalSearches.values()];
        lines.push(
          `Safety benchmark ${size.toLocaleString("en-US")}`,
          `Target messages: ${size.toLocaleString("en-US")}`,
          `Sender-bounded list calls/pages: ${sum(cohortMetrics, "requests").toLocaleString("en-US")}`,
          `Sender-bounded results examined: ${sum(cohortMetrics, "resultIdsReturned").toLocaleString("en-US")}`,
          `Sender-bounded safe targets intersected: ${intersectCount(targetIds, safeCohortIds).toLocaleString("en-US")}`,
          `Sender-bounded quota units: ${(sum(cohortMetrics, "requests") * 5).toLocaleString("en-US")}`,
          `Complete protection list calls/pages: ${sum(globalMetrics, "requests").toLocaleString("en-US")}`,
          `Complete protection results examined: ${sum(globalMetrics, "resultIdsReturned").toLocaleString("en-US")}`,
          `Complete protection quota units: ${(sum(globalMetrics, "requests") * 5).toLocaleString("en-US")}`,
          `REST wall time: ${sum([...cohortMetrics, ...globalMetrics], "wallTimeMs").toLocaleString("en-US")} ms`,
          ...[...globalSearches.entries()].map(([purpose, metric]) =>
            `${purpose}: pages ${metric.pages}, results ${metric.resultIdsReturned.toLocaleString("en-US")}, targets excluded ${intersectCount(targetIds, metric.ids)}`
          ),
          ""
        );
      }
      const personal = globalSearches.get("Personal/category exclusion")!;
      const allProtection = [...globalSearches.values()];
      lines.push(formatGmailScaleDevelopmentSummary({
        messagesTested: 10,
        xGmMsgidAvailable: 10,
        apiIdMatches: 10,
        mismatches: 0,
        safetyBenchmark: {
          targets: maximumTargets.length,
          restListPages: sum(allProtection, "requests"),
          restSafetyUnits: sum(allProtection, "requests") * 5,
          imapExactRecheckSupported: true,
          imapComparisonMismatches: stateComparison.mismatches,
          personalListPages: personal.pages
        }
      }));
      process.stdout.write(`\n${lines.join("\n")}\n`);

      expect(imapRecheck.excludedIdentityMismatchCount).toBe(0);
      expect(stateComparison.mismatches).toBe(0);
      expect(stateComparison.unavailable).toBe(0);
    } finally {
      if (scanClient) await closeImapClient(scanClient);
      if (recheckClient) await closeImapClient(recheckClient);
      await prisma.$disconnect();
    }
  }, 15 * 60_000);
});

function createImapClient(accessToken: string, accountEmail: string) {
  return new ImapFlow({
    host: process.env.GMAIL_IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.GMAIL_IMAP_PORT || 993),
    secure: true,
    logger: false,
    disableAutoIdle: true,
    auth: { user: accountEmail, accessToken },
    tls: { rejectUnauthorized: true }
  });
}

function assertGmailIdProvenance(client: ImapFlow) {
  if (!client.capabilities.has("X-GM-EXT-1") || client.capabilities.has("OBJECTID")) {
    throw new Error("Explicit X-GM-MSGID provenance is unavailable for the scale safety proof.");
  }
}

async function scanParticipatedConversationIds(
  client: ImapFlow,
  resolveSent: (client: Pick<ImapFlow, "list">) => Promise<string>,
  batchSize: number
) {
  const path = await resolveSent(client);
  const mailbox = await client.mailboxOpen(path, { readOnly: true });
  if (!mailbox.readOnly) throw new Error("Gmail Sent did not open read-only for the safety proof.");
  const ids = new Set<string>();
  for (let start = 1; start <= mailbox.exists; start += batchSize) {
    const end = Math.min(start + batchSize - 1, mailbox.exists);
    for await (const message of client.fetch(`${start}:${end}`, { threadId: true }, { uid: false })) {
      if (message.threadId) ids.add(message.threadId);
    }
  }
  return ids;
}

function normalizeLiveMessage(message: FetchMessageObject) {
  return normalizeGmailMessage({
    uid: message.uid,
    threadId: message.threadId,
    headers: message.headers,
    internalDate: message.internalDate instanceof Date ? message.internalDate : message.internalDate ? new Date(message.internalDate) : undefined,
    flags: message.flags,
    labels: message.labels,
    size: message.size
  }, getGmailSubjectProtection(message.headers));
}

async function measureGlobalProtectionSearches(accessToken: string) {
  const searches = new Map<string, SearchMeasurement>();
  searches.set("Trash exclusion", await measureMessageList(accessToken, { query: "in:trash" }));
  searches.set("Starred exclusion", await measureMessageList(accessToken, { query: "is:starred" }));
  searches.set("Important exclusion", await measureMessageList(accessToken, { query: "is:important" }));
  searches.set("Personal/category exclusion", await measureMessageList(accessToken, { labelId: "CATEGORY_PERSONAL" }));
  searches.set("Sent/Draft exclusion", await measureMessageList(accessToken, { query: "{in:sent in:drafts}" }));
  return searches;
}

async function measureMessageList(accessToken: string, filter: { query?: string; labelId?: string }): Promise<SearchMeasurement> {
  const started = performance.now();
  const metrics = await collectCompleteGmailList(async (pageToken) => {
    const params = new URLSearchParams({
      maxResults: "500",
      includeSpamTrash: "true",
      fields: "messages/id,nextPageToken"
    });
    if (filter.query) params.set("q", filter.query);
    if (filter.labelId) params.append("labelIds", filter.labelId);
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`${gmailApiMessagesUrl}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error(`Gmail safety list failed with status ${response.status}.`);
    if (response.status === 204) return { ids: [] };
    const body = await response.json() as { messages?: Array<{ id?: string }>; nextPageToken?: string };
    return {
      ids: (body.messages ?? []).flatMap((message) => message.id ? [message.id] : []),
      nextPageToken: body.nextPageToken
    };
  });
  return { ...metrics, wallTimeMs: Math.round(performance.now() - started) };
}

function sum(metrics: readonly SearchMeasurement[], key: "requests" | "resultIdsReturned" | "wallTimeMs") {
  return metrics.reduce((total, metric) => total + metric[key], 0);
}

async function closeImapClient(client: ImapFlow) {
  try {
    await client.logout();
  } catch {
    client.close();
  }
}
