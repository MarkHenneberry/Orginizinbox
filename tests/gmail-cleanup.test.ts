import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocateCleanupCountAcrossGroups,
  assessGmailApiCleanupCandidate,
  assessGmailMutableLabels,
  buildCleanupSenderGroups,
  buildGmailSenderCleanupQuery,
  isEligibleGmailApiCleanupCandidate,
  type GmailMinimalMessageMetadata
} from "@/lib/providers/gmail/cleanup-candidates";
import {
  createDefaultCleanupSelection,
  eligibleCleanupGroupIndices,
  filterAndSortCleanupGroups,
  updateCleanupSelection
} from "@/lib/domain/cleanup-sender-workspace";
import { estimateGmailCleanupQuota } from "@/lib/providers/gmail/quota";
import { assertTrashAccounting, summarizeTrashMutationResult } from "@/lib/providers/gmail/trash-utils";
import type { SenderAggregate } from "@/lib/domain/types";

const now = new Date("2026-08-25T12:00:00Z");
const safetyContext = {
  expectedSenderAddress: "deals@example.test",
  participatedConversationIds: new Set<string>(),
  now
};

function minimalMessage(overrides: Partial<GmailMinimalMessageMetadata> = {}): GmailMinimalMessageMetadata {
  return {
    id: "native-gmail-api-id",
    threadId: "thread-1",
    labelIds: ["CATEGORY_PROMOTIONS"],
    internalDate: String(new Date("2024-01-01T00:00:00Z").getTime()),
    sizeEstimate: 1024,
    headers: [
      { name: "From", value: "Deals <deals@example.test>" },
      { name: "List-Id", value: "offers.example" }
    ],
    ...overrides
  };
}

function sender(overrides: Partial<SenderAggregate> = {}): SenderAggregate {
  return {
    senderKey: "deals@example.test",
    displayName: "Deals",
    domain: "example.test",
    totalMessages: 180,
    unreadMessages: 150,
    readMessages: 30,
    unreadRatio: 150 / 180,
    oldMessages: 160,
    veryOldMessages: 120,
    recentMessages: 20,
    protectedMessages: 25,
    reviewMessages: 30,
    cleanupCandidateCount: 125,
    oldestMessageAt: new Date("2020-01-01T00:00:00Z"),
    newestMessageAt: new Date("2026-08-01T00:00:00Z"),
    estimatedBytes: 1000,
    estimatedEligibleBytes: 700,
    recurring: true,
    classification: "BULK_NEWSLETTER",
    cleanupConfidence: "high",
    reasonCodes: ["HAS_LIST_ID"],
    protectionReasons: [],
    ...overrides
  };
}

describe("gmail cleanup query construction", () => {
  it("uses exact sender, age rule, and protection exclusions without subject or body criteria", () => {
    const query = buildGmailSenderCleanupQuery({ senderAddress: "Deals@Example.test", now });

    expect(query).toContain('from:("deals@example.test")');
    expect(query).toContain("before:2026/02/26");
    expect(query).toContain("-in:trash");
    expect(query).toContain("-is:starred");
    expect(query).toContain("-is:important");
    expect(query).toContain("-in:sent");
    expect(query).toContain("-in:drafts");
    expect(query).toContain("-category:primary");
    expect(query).not.toMatch(/subject|body|snippet|payload|attachment/i);
  });

  it("quotes safe unusual addresses and rejects malformed query identities", () => {
    expect(buildGmailSenderCleanupQuery({ senderAddress: "deals+o'brien@example.test", now })).toContain(
      'from:("deals+o\'brien@example.test")'
    );
    expect(() => buildGmailSenderCleanupQuery({ senderAddress: "bad(address)@example.test", now })).toThrow(
      /Invalid canonical/
    );
  });
});

describe("gmail native id resolution", () => {
  it("uses users.messages.list and native ids instead of IMAP emailId conversion", () => {
    const client = readFileSync("src/lib/providers/gmail/gmail-api-client.ts", "utf8");
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const provider = readFileSync("src/lib/providers/gmail/provider.ts", "utf8");

    expect(client).toMatch(/resolveCleanupCandidatesForSender/);
    expect(client).toMatch(/fields: "messages\/id,nextPageToken"/);
    expect(client).toMatch(/pageToken/);
    expect(cleanup).toMatch(/trashClient\.resolveCleanupCandidatesForSender/);
    expect(`${client}\n${cleanup}`).not.toMatch(/BigInt|gmailImapDecimalIdToApiHex|X-GM-MSGID|message\.emailId/);
    expect(provider).not.toMatch(/resolveCleanupCandidatesForSender|gmailImapDecimalIdToApiHex/);
  });

  it("keeps the development cap enforced server-side", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");

    expect(cleanup).toMatch(/runtimeConfig\.gmailCleanupMaxMessages/);
    expect(cleanup).toMatch(/parsed > runtimeConfig\.gmailCleanupMaxMessages \|\| parsed > gmailCleanupHardMaximum/);
    expect(cleanup).toMatch(/gmailCleanupHardMaximum = 100/);
  });

  it("documents why ImapFlow emailId was not a reliable Gmail API id source", () => {
    const imapflowFetch = readFileSync("node_modules/imapflow/lib/commands/fetch.js", "utf8");

    expect(imapflowFetch).toMatch(/connection\.capabilities\.has\('OBJECTID'\)[\s\S]+EMAILID/);
    expect(imapflowFetch).toMatch(/connection\.capabilities\.has\('X-GM-EXT-1'\)[\s\S]+X-GM-MSGID/);
  });
});

describe("gmail minimal metadata protection", () => {
  it("uses only minimal Gmail fields and rejects protected labels", () => {
    const client = readFileSync("src/lib/providers/gmail/gmail-api-client.ts", "utf8");

    expect(client).toMatch(/id,threadId,labelIds,internalDate,sizeEstimate,payload\(headers\(name,value\)\)/);
    expect(client).toMatch(/format:\s*"metadata"/);
    expect(client).toMatch(/"From", "List-Id", "List-Unsubscribe", "Auto-Submitted", "Precedence", "Subject"/);
    expect(client).not.toMatch(/snippet|bodyParts|attachment/i);
    expect(isEligibleGmailApiCleanupCandidate(minimalMessage(), safetyContext)).toBe(true);
    expect(isEligibleGmailApiCleanupCandidate(minimalMessage({ labelIds: ["TRASH"] }), safetyContext)).toBe(false);
    expect(isEligibleGmailApiCleanupCandidate(minimalMessage({ labelIds: ["STARRED"] }), safetyContext)).toBe(false);
    expect(isEligibleGmailApiCleanupCandidate(minimalMessage({ labelIds: ["IMPORTANT"] }), safetyContext)).toBe(false);
    expect(isEligibleGmailApiCleanupCandidate(minimalMessage({ labelIds: ["SENT"] }), safetyContext)).toBe(false);
    expect(isEligibleGmailApiCleanupCandidate(minimalMessage({ labelIds: ["DRAFT"] }), safetyContext)).toBe(false);
    expect(isEligibleGmailApiCleanupCandidate(minimalMessage({ labelIds: ["CATEGORY_PERSONAL"] }), safetyContext)).toBe(false);
    expect(
      isEligibleGmailApiCleanupCandidate(
        minimalMessage({
          headers: [
            { name: "From", value: "Deals <deals@example.test>" },
            { name: "List-Id", value: "offers.example" },
            { name: "Subject", value: "Your receipt from Runway AI, Inc. #2429-0529" }
          ]
        }),
        safetyContext
      )
    ).toBe(false);
    expect(
      isEligibleGmailApiCleanupCandidate(
        minimalMessage({ internalDate: String(new Date("2026-08-01T00:00:00Z").getTime()) }),
        safetyContext
      )
    ).toBe(false);
    expect(
      isEligibleGmailApiCleanupCandidate(minimalMessage(), {
        ...safetyContext,
        participatedConversationIds: new Set(["thread-1"])
      })
    ).toBe(false);
    expect(
      isEligibleGmailApiCleanupCandidate(
        minimalMessage({ headers: [{ name: "From", value: "Other <other@example.test>" }] }),
        safetyContext
      )
    ).toBe(false);
    expect(
      isEligibleGmailApiCleanupCandidate(
        minimalMessage({ labelIds: [], headers: [{ name: "From", value: "Deals <deals@example.test>" }] }),
        safetyContext
      )
    ).toBe(false);
  });

  it("returns allowlisted exclusion reasons for every final safety rule", () => {
    expect(assessGmailApiCleanupCandidate(minimalMessage({ labelIds: ["STARRED"] }), safetyContext).exclusionReasons).toContain("STARRED");
    expect(assessGmailApiCleanupCandidate(minimalMessage({ labelIds: ["IMPORTANT"] }), safetyContext).exclusionReasons).toContain("IMPORTANT");
    expect(assessGmailApiCleanupCandidate(minimalMessage({ labelIds: ["SENT"] }), safetyContext).exclusionReasons).toContain("SENT");
    expect(assessGmailApiCleanupCandidate(minimalMessage({ labelIds: ["DRAFT"] }), safetyContext).exclusionReasons).toContain("DRAFT");
    expect(assessGmailApiCleanupCandidate(minimalMessage({ labelIds: ["CATEGORY_PERSONAL"] }), safetyContext).exclusionReasons).toContain("PERSONAL_CATEGORY");
    expect(assessGmailApiCleanupCandidate(minimalMessage({ labelIds: ["TRASH"] }), safetyContext).exclusionReasons).toContain("ALREADY_TRASH");
    expect(assessGmailApiCleanupCandidate(minimalMessage({ internalDate: String(now.getTime()) }), safetyContext).exclusionReasons).toContain("RECENT");
    expect(
      assessGmailApiCleanupCandidate(minimalMessage(), {
        ...safetyContext,
        participatedConversationIds: new Set(["thread-1"])
      }).exclusionReasons
    ).toContain("PARTICIPATED_CONVERSATION");
    expect(
      assessGmailApiCleanupCandidate(minimalMessage(), {
        ...safetyContext,
        protectedSenders: new Set(["example.test"])
      }).exclusionReasons
    ).toContain("PROTECTED_SENDER");
  });

  it("lets Subject remove eligibility but never create strong cleanup evidence", () => {
    const noStrongEvidence = minimalMessage({
      labelIds: [],
      headers: [{ name: "From", value: "Deals <deals@example.test>" }]
    });
    const protectedSubject = minimalMessage({
      headers: [
        { name: "From", value: "Deals <deals@example.test>" },
        { name: "List-Id", value: "offers.example" },
        { name: "Subject", value: "Security alert for your account" }
      ]
    });

    expect(assessGmailApiCleanupCandidate(noStrongEvidence, safetyContext).exclusionReasons).toContain("STRONG_EVIDENCE_MISSING");
    expect(assessGmailApiCleanupCandidate(protectedSubject, safetyContext).exclusionReasons).toContain("PROTECTED_SUBJECT");
  });
});

describe("cleanup group eligibility", () => {
  it("shows all groups but enables only Ready High and Very High groups", () => {
    const groups = buildCleanupSenderGroups([
      sender({ cleanupConfidence: "high" }),
      sender({ senderKey: "very@example.test", cleanupConfidence: "very_high", cleanupCandidateCount: 100 }),
      sender({ senderKey: "review@example.test", cleanupConfidence: "review" }),
      sender({ senderKey: "keep@example.test", cleanupConfidence: "keep" })
    ]);

    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.cleanupConfidence)).toEqual(["high", "very_high", "review", "keep"]);
    expect(groups.map((group) => group.eligible)).toEqual([true, true, false, false]);
    expect(groups[2].ineligibleReason).toBe("REVIEW_GROUP");
    expect(groups[3].ineligibleReason).toBe("KEEP_GROUP");
    expect(groups[0]).toMatchObject({ totalMessages: 180, cleanupCandidateCount: 125, reviewMessages: 30, protectedMessages: 25 });
  });

  it("keeps zero-Ready and protected senders visible but non-selectable", () => {
    const groups = buildCleanupSenderGroups([
      sender({ senderKey: "empty@example.test", cleanupCandidateCount: 0 }),
      sender({ senderKey: "protected@example.test", protectionReasons: ["PROTECTED_SENDER"] })
    ]);

    expect(groups).toMatchObject([
      { eligible: false, ineligibleReason: "NO_READY_MESSAGES" },
      { eligible: false, ineligibleReason: "PROTECTED_SENDER" }
    ]);
  });

  it("selects every eligible sender by default and never auto-selects Review, Keep, protected, or zero-Ready groups", () => {
    const groups = buildCleanupSenderGroups([
      sender({ senderKey: "high@example.test", cleanupConfidence: "high" }),
      sender({ senderKey: "very@example.test", cleanupConfidence: "very_high" }),
      sender({ senderKey: "review@example.test", cleanupConfidence: "review" }),
      sender({ senderKey: "keep@example.test", cleanupConfidence: "keep" }),
      sender({ senderKey: "protected@example.test", protectionReasons: ["PROTECTED_SENDER"] }),
      sender({ senderKey: "zero@example.test", cleanupCandidateCount: 0 })
    ]);

    expect(eligibleCleanupGroupIndices(groups)).toEqual([0, 1]);
    expect([...createDefaultCleanupSelection(groups)]).toEqual([0, 1]);
  });

  it("clears and restores the full eligible selection while filtered changes preserve hidden choices", () => {
    const groups = buildCleanupSenderGroups([
      sender({ senderKey: "alpha@example.test", displayName: "Alpha" }),
      sender({ senderKey: "beta@example.test", displayName: "Beta" }),
      sender({ senderKey: "gamma@example.test", displayName: "Gamma" })
    ]);
    const eligible = eligibleCleanupGroupIndices(groups);
    const initial = createDefaultCleanupSelection(groups);
    filterAndSortCleanupGroups(groups, "", "recommendation");
    expect([...initial]).toEqual([0, 1, 2]);
    const cleared = updateCleanupSelection(initial, eligible, false);
    const restored = updateCleanupSelection(cleared, eligible, true);
    const filtered = filterAndSortCleanupGroups(groups, "beta", "ready").map((group) => group.index);
    const filteredCleared = updateCleanupSelection(restored, filtered, false);

    expect([...cleared]).toEqual([]);
    expect([...restored]).toEqual([0, 1, 2]);
    expect([...filteredCleared]).toEqual([0, 2]);
    expect([...updateCleanupSelection(filteredCleared, filtered, true)]).toEqual([0, 2, 1]);
  });

  it("allocates a combined count deterministically without letting one sender monopolize it", () => {
    const groups = buildCleanupSenderGroups([
      sender({ senderKey: "high@example.test", cleanupConfidence: "high", cleanupCandidateCount: 20 }),
      sender({ senderKey: "very-a@example.test", cleanupConfidence: "very_high", cleanupCandidateCount: 20 }),
      sender({ senderKey: "very-b@example.test", cleanupConfidence: "very_high", cleanupCandidateCount: 10 })
    ]);

    expect(allocateCleanupCountAcrossGroups(groups, 8).map(({ group, requestedCount }) => [group.index, requestedCount])).toEqual([
      [1, 3],
      [2, 3],
      [0, 2]
    ]);
  });

  it("searches the complete sender set and supports every cleanup sort", () => {
    const groups = buildCleanupSenderGroups([
      sender({ displayName: "Alpha", senderSecondaryLabel: "alpha@example.test", cleanupCandidateCount: 10 }),
      sender({ displayName: "Beta", senderKey: "beta@example.test", domain: "news.test", cleanupCandidateCount: 40, totalMessages: 500 }),
      sender({ displayName: "Gamma", senderKey: "gamma@example.test", cleanupConfidence: "review", cleanupCandidateCount: 5, unreadMessages: 170 })
    ]);

    expect(filterAndSortCleanupGroups(groups, "news.test", "ready").map((group) => group.displayName)).toEqual(["Beta"]);
    expect(filterAndSortCleanupGroups(groups, "", "ready")[0].displayName).toBe("Beta");
    expect(filterAndSortCleanupGroups(groups, "", "emails")[0].displayName).toBe("Beta");
    expect(filterAndSortCleanupGroups(groups, "", "unread")[0].displayName).toBe("Gamma");
    expect(filterAndSortCleanupGroups(groups, "", "oldest")).toHaveLength(3);
    expect(filterAndSortCleanupGroups(groups, "", "storage")).toHaveLength(3);
    expect(filterAndSortCleanupGroups(groups, "", "recommendation")).toHaveLength(3);
  });

  it("renders accessible multi-select controls and one desktop-only bounded scroll region", () => {
    const ui = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");

    expect(ui).toMatch(/type="checkbox"/);
    expect(ui).toMatch(/disabled=\{!group\.eligible \|\| busy\}/);
    expect(ui).toContain("eligible senders selected");
    expect(ui).toContain("Ready emails available");
    expect(ui).toContain("Clear selection");
    expect(ui).toContain("Select all eligible");
    expect(ui).toContain("Select all eligible results");
    expect(ui).toContain("Clear eligible results");
    expect(ui).toMatch(/>Search[\s\S]+id="cleanup-search"/);
    expect(ui).toMatch(/>Sort[\s\S]+id="cleanup-sort"/);
    expect(ui).toMatch(/aria-label="Sender groups"[\s\S]+lg:max-h-\[calc\(100vh-18rem\)\][\s\S]+lg:overflow-y-auto[\s\S]+tabIndex=\{0\}/);
    expect(ui).toContain("Not selectable: needs review");
    expect(ui).toContain("Not enough evidence to clean automatically.");
    expect(ui).toContain("These messages look important or protected.");
    expect(ui).toContain("Nothing available to clean automatically.");
    expect(ui).toContain("Review excluded");
    expect(ui).toContain("Protected excluded");
    expect(ui).toContain("be checked safely, so we left");
  });

  it("sends stable report indices and resolves canonical server-side sender identities", () => {
    const ui = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");

    expect(ui).toMatch(/const groupIndices = \[\.\.\.selectedGroupIndices\]/);
    expect(ui).toMatch(/JSON\.stringify\(\{ groupIndices, requestedCount, benchmarkOnly \}\)/);
    expect(cleanup).toMatch(/const reportSender = report\.senders\[group\.index\]/);
    expect(cleanup).toMatch(/normalizeGmailCleanupSenderIdentity\(reportSender\.senderKey\)/);
    expect(cleanup).not.toMatch(/senderAddress:\s*group\.displayName/);
  });
});

describe("confirmation safety and quota model", () => {
  it("rechecks mutable labels without weakening protection", () => {
    expect(assessGmailMutableLabels(["CATEGORY_PROMOTIONS"], true)).toEqual([]);
    expect(assessGmailMutableLabels(["CATEGORY_PROMOTIONS", "STARRED"], true)).toContain("STARRED");
    expect(assessGmailMutableLabels([], true)).toContain("STRONG_EVIDENCE_MISSING");
    expect(assessGmailMutableLabels(["CATEGORY_PRIMARY"], false)).toContain("PERSONAL_CATEGORY");
  });

  it("profiles the current 100-message path and shows why 1,000 is not enabled", () => {
    expect(estimateGmailCleanupQuota({ messageCount: 100, senderGroupCount: 2 })).toMatchObject({
      preview: 2010,
      confirmation: 10,
      mutation: 50,
      verification: 2000,
      beforeUndo: 4070
    });
    expect(estimateGmailCleanupQuota({ messageCount: 100, senderGroupCount: 2 })).toMatchObject({
      undo: 500,
      includingUndo: 4570
    });
    expect(
      estimateGmailCleanupQuota({
        messageCount: 100,
        senderGroupCount: 2,
        undoFallbackVerificationCount: 2
      }).undo
    ).toBe(540);
    expect(estimateGmailCleanupQuota({ messageCount: 1000, senderGroupCount: 2 }).beforeUndo).toBeGreaterThan(40_000);
  });
});

describe("gmail cleanup gates and privacy", () => {
  it("keeps cleanup disabled by default and capped", () => {
    const config = readFileSync("src/lib/config.ts", "utf8");
    const envExample = readFileSync(".env.example", "utf8");

    expect(config).toMatch(/GMAIL_CLEANUP_ENABLED:[\s\S]+default\("false"\)/);
    expect(config).toMatch(/GMAIL_CLEANUP_MAX_MESSAGES:[\s\S]+max\(100\)[\s\S]+default\(5\)/);
    expect(envExample).toMatch(/GMAIL_CLEANUP_ENABLED="false"/);
    expect(envExample).toMatch(/GMAIL_CLEANUP_MAX_MESSAGES="100"/);
    expect(config).toMatch(/GMAIL_CLEANUP_RECHECK_CONCURRENCY:[\s\S]+max\(10\)[\s\S]+default\(8\)/);
  });

  it("requires local-only mode, live report, Gmail connection, scope guard, and explicit confirmation", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const confirmRoute = readFileSync("app/api/dev/gmail-cleanup/confirm/route.ts", "utf8");

    expect(cleanup).toMatch(/NODE_ENV === "production"/);
    expect(cleanup).toMatch(/runtimeConfig\.fixtureMode/);
    expect(cleanup).toMatch(/runtimeConfig\.gmailCleanupEnabled/);
    expect(cleanup).toMatch(/getActiveGmailConnection/);
    expect(cleanup).toMatch(/liveScan\.progress\.status !== "completed"/);
    expect(cleanup).toMatch(/gmailCleanupConfirmation = "MOVE_TO_TRASH"/);
    expect(cleanup).toMatch(/selectedGroups\.some\(\(group\) => !group\?\.eligible\)/);
    expect(cleanup).toMatch(/selectedReadyCount < input\.requestedCount/);
    expect(cleanup).toMatch(/liveScan\.reportStale/);
    expect(cleanup).toMatch(/recheckCleanupCandidates/);
    expect(cleanup).toMatch(/participatedConversationIds/);
    expect(confirmRoute).toMatch(/confirmGmailCleanup/);
  });

  it("serializes cleanup jobs without Gmail API message ids or sender identities", () => {
    const store = readFileSync("src/lib/server/gmail-cleanup-store.ts", "utf8");
    const serializer = store.slice(store.indexOf("export function serializeGmailCleanupJob"));

    expect(serializer).not.toMatch(/apiMessageIds/);
    expect(serializer).not.toMatch(/senderAddress|senderKey|encrypted|accessToken|refreshToken/);
  });

  it("keeps native ids transient and uses the current report and ProviderConnection without restarting OAuth", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const store = readFileSync("src/lib/server/gmail-cleanup-store.ts", "utf8");
    const schema = readFileSync("prisma/schema.prisma", "utf8");

    expect(cleanup).toMatch(/getActiveGmailConnection/);
    expect(cleanup).toMatch(/context\.liveScan\.progress\.scanId !== job\.scanId/);
    expect(cleanup).not.toMatch(/oauth\/google\/start|createGoogleAuthorizationUrl|exchangeGoogleCode/);
    expect(store).toMatch(/apiCandidates: GmailCleanupStoredCandidate\[\]/);
    expect(store).toMatch(/confirmationExpiresAt/);
    expect(schema).not.toMatch(/apiMessageIds|cleanupCandidateIds|messageMetadata|rawSubject|conversationIds/);
  });

  it("refuses mutation when the exact confirmation-time safe count is unavailable", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const confirm = cleanup.slice(cleanup.indexOf("export async function confirmGmailCleanup"), cleanup.indexOf("export async function undoGmailCleanup"));
    const recheckPosition = confirm.indexOf("runConfirmationRecheck");
    const countGuardPosition = confirm.indexOf("eligibleCandidates.length !== job.requestedCount");
    const batchPosition = confirm.indexOf("batchModifyTrash");

    expect(recheckPosition).toBeGreaterThan(-1);
    expect(countGuardPosition).toBeGreaterThan(recheckPosition);
    expect(batchPosition).toBeGreaterThan(countGuardPosition);
    expect(cleanup).toMatch(/INSUFFICIENT_SAFE_CANDIDATES/);
    expect(cleanup).toMatch(/mutationStarted: false/);
  });

  it("keeps the benchmark non-mutating and confirmation snapshots short-lived", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const store = readFileSync("src/lib/server/gmail-cleanup-store.ts", "utf8");
    const benchmark = cleanup.slice(cleanup.indexOf("async function completeNonMutatingBenchmark"), cleanup.indexOf("async function runConfirmationRecheck"));

    expect(benchmark).not.toMatch(/batchModifyTrash|verifyMessagesInTrash|markLiveReportStale/);
    expect(cleanup).toMatch(/job\.benchmarkOnly[\s\S]+cannot start a Gmail mutation/);
    expect(store).toMatch(/gmailCleanupConfirmationTtlMs = 2 \* 60 \* 1000/);
    expect(cleanup).toMatch(/job\.confirmationExpiresAt < Date\.now\(\)/);
  });

  it("marks the report stale after mutation and never marks it current during Undo", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const undo = cleanup.slice(cleanup.indexOf("export async function undoGmailCleanup"));

    expect(cleanup).toMatch(/batchModifyTrash[\s\S]+markLiveReportStale/);
    expect(undo).not.toMatch(/markLiveReportCurrent|reportStale:\s*false/);
  });

  it("expires transient Undo state and keeps rescan on the existing connection lifecycle", () => {
    const store = readFileSync("src/lib/server/gmail-cleanup-store.ts", "utf8");
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const scan = readFileSync("src/lib/server/gmail-benchmark.ts", "utf8");

    expect(store).toMatch(/job\.expiresAt < Date\.now\(\)[\s\S]+gmailCleanupJobs\.delete/);
    expect(cleanup).toMatch(/Cleanup result expired/);
    expect(scan).toMatch(/getActiveGmailConnection/);
    expect(scan).not.toMatch(/createGoogleAuthorizationUrl|oauth\/google\/start/);
  });
});

describe("gmail trash mutation accounting", () => {
  it("reconciles result accounting", () => {
    expect(summarizeTrashMutationResult({ requested: 5, attemptedCount: 5, verifiedCount: 4, failedCount: 0, uncertainCount: 1 })).toEqual({
      requested: 5,
      attemptedCount: 5,
      verifiedCount: 4,
      failedCount: 0,
      uncertainCount: 1,
      verifiedTrashCount: 4
    });
    expect(() => assertTrashAccounting({ attemptedCount: 5, verifiedCount: 0, failedCount: 0, uncertainCount: 0 })).toThrow(/accounting/);
  });

  it("uses one controlled batchModify path with separate verification", () => {
    const client = readFileSync("src/lib/providers/gmail/gmail-api-client.ts", "utf8");
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const ui = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");

    expect(cleanup).toMatch(/batchModifyTrash/);
    expect(cleanup).toMatch(/verifyMessagesInTrash/);
    expect(client).toMatch(/batchModify/);
    expect(client).toMatch(/addLabelIds:\s*\["TRASH"\]/);
    expect(client).toMatch(/removeLabelIds:\s*\[\]/);
    expect(client).not.toMatch(/\/trash`|\/trash"|\/trash'/);
    expect(ui).toMatch(/Uncertain/);
  });

  it("uses untrash response labels as the primary Undo verification and only falls back when labels are absent", () => {
    const client = readFileSync("src/lib/providers/gmail/gmail-api-client.ts", "utf8");
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");

    expect(client).toMatch(/untrash\?fields=id,labelIds/);
    expect(client).toMatch(/responseLabels\.has\("TRASH"\)/);
    expect(client).toMatch(/getMessageLabels\(ids\[index\], "undoFallbackLabels"\)/);
    expect(cleanup).toMatch(/trashClient\.untrashAndVerifyMessages/);
    expect(cleanup).toMatch(/job\.apiCandidates\.map\(\(candidate\) => candidate\.apiMessageId\)/);
    expect(cleanup).not.toMatch(/verifyMessagesRestored|untrashMessages/);
  });

  it("does not implement permanent-delete or unrelated mail capabilities", () => {
    const appAndSrc = [
      readFileSync("src/lib/providers/gmail/gmail-api-client.ts", "utf8"),
      readFileSync("src/lib/providers/gmail/provider.ts", "utf8"),
      readFileSync("src/lib/server/gmail-cleanup.ts", "utf8"),
      readFileSync("app/api/dev/gmail-cleanup/resolve/route.ts", "utf8"),
      readFileSync("app/api/dev/gmail-cleanup/confirm/route.ts", "utf8"),
      readFileSync("app/api/dev/gmail-cleanup/undo/route.ts", "utf8")
    ].join("\n");

    expect(appAndSrc).not.toMatch(/messages\.delete|batchDelete|threads\.delete|EXPUNGE|messageDelete|mailboxDelete|createDraft|sendEmail|SMTP/i);
  });

  it("uses label-only metadata for verification and never persists or logs Subject", () => {
    const client = readFileSync("src/lib/providers/gmail/gmail-api-client.ts", "utf8");
    const candidates = readFileSync("src/lib/providers/gmail/cleanup-candidates.ts", "utf8");
    const schema = readFileSync("prisma/schema.prisma", "utf8");

    expect(client).toMatch(/gmailVerificationFields = "id,labelIds"/);
    expect(client).toMatch(/getMessageLabels/);
    expect(`${client}\n${candidates}`).not.toMatch(/console\.|logger\.|analytics/);
    expect(schema).not.toMatch(/subject/i);
  });
});
