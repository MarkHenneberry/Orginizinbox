import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildGmailSenderCleanupQuery,
  createGmailCleanupExclusionCounts,
  normalizeGmailCleanupSenderIdentity,
  type CleanupSenderGroup
} from "@/lib/providers/gmail/cleanup-candidates";
import {
  GmailApiRequestError,
  GmailCandidateResolutionStageError,
  GmailTrashClient
} from "@/lib/providers/gmail/gmail-api-client";
import {
  GmailSenderGroupResolutionError,
  resolveGmailCleanupSenderGroups
} from "@/lib/providers/gmail/group-resolution";
import { parseSender } from "@/lib/providers/gmail/metadata";
import { classifySenderGroupResolutionError } from "@/lib/server/gmail-cleanup";

function group(index: number, overrides: Partial<CleanupSenderGroup> = {}): CleanupSenderGroup {
  return {
    index,
    displayName: `Sender ${index}`,
    secondaryLabel: `sender-${index}.example.test`,
    searchableIdentity: `sender-${index}@example.test`,
    totalMessages: 50,
    unreadMessages: 40,
    oldMessages: 45,
    oldestMessageAt: new Date("2020-01-01T00:00:00Z"),
    estimatedEligibleBytes: 1000,
    protectedMessages: 2,
    reviewMessages: 3,
    cleanupCandidateCount: 10,
    cleanupConfidence: "high",
    eligible: true,
    ...overrides
  };
}

function resolution(groupIndex: number, limit: number, timings = { candidate: 10, safety: 20 }) {
  return {
    candidates: Array.from({ length: limit }, (_, index) => ({
      apiMessageId: `group-${groupIndex}-message-${index}`,
      requiresMutableStrongEvidenceRecheck: false
    })),
    exclusionCounts: createGmailCleanupExclusionCounts(),
    excludedMessageCount: 0,
    candidateResolutionMs: timings.candidate,
    previewSafetyCheckMs: timings.safety
  };
}

describe("multi-sender Gmail candidate resolution", () => {
  it("supports 43 selected groups and redistributes one local query failure", async () => {
    const groups = Array.from({ length: 43 }, (_, index) => group(index));
    const result = await resolveGmailCleanupSenderGroups({
      selectedGroups: groups,
      requestedCount: 100,
      concurrency: 8,
      resolveGroup: async (selectedGroup, limit) => {
        if (selectedGroup.index === 7) {
          throw new GmailSenderGroupResolutionError("QUERY_BUILD_FAILED", false, 4, 0);
        }
        return resolution(selectedGroup.index, limit);
      }
    });

    expect(result).toMatchObject({
      selectedCount: 43,
      attemptedCount: 43,
      successfulCount: 42,
      failedCount: 1,
      zeroSafeCandidateCount: 0,
      contributingCount: 42,
      globalFailure: false
    });
    expect(result.candidates).toHaveLength(100);
    expect(result.failureReasonCounts.QUERY_BUILD_FAILED).toBe(1);
    expect(result).toMatchObject({
      localFailureCount: 1,
      globalProviderFailureCount: 0,
      globalApplicationFailureCount: 0,
      classifiedFailureCount: 1,
      failureAccountingInvariant: true
    });
    expect(result.candidates.some((candidate) => candidate.groupIndex === 7)).toBe(false);
  });

  it("removes an entire group if a later expanded resolution fails", async () => {
    const calls = new Map<number, number>();
    const result = await resolveGmailCleanupSenderGroups({
      selectedGroups: [group(0), group(1), group(2)],
      requestedCount: 8,
      concurrency: 3,
      resolveGroup: async (selectedGroup, limit) => {
        const call = (calls.get(selectedGroup.index) ?? 0) + 1;
        calls.set(selectedGroup.index, call);
        if (selectedGroup.index === 1 && call > 1) {
          throw new GmailSenderGroupResolutionError("METADATA_RECHECK_FAILED", false, 5, 6);
        }
        if (selectedGroup.index === 0 && call === 1) return resolution(0, limit - 1);
        return resolution(selectedGroup.index, limit);
      }
    });

    expect(result.candidates).toHaveLength(8);
    expect(result.failedCount).toBe(1);
    expect(result.failureReasonCounts.METADATA_RECHECK_FAILED).toBe(1);
    expect(result.candidates.some((candidate) => candidate.groupIndex === 1)).toBe(false);
  });

  it("handles multiple local failures and reports insufficient candidates without weakening checks", async () => {
    const result = await resolveGmailCleanupSenderGroups({
      selectedGroups: [group(0, { cleanupCandidateCount: 2 }), group(1), group(2), group(3)],
      requestedCount: 10,
      concurrency: 4,
      resolveGroup: async (selectedGroup, limit) => {
        if (selectedGroup.index === 1) {
          throw new GmailSenderGroupResolutionError("PROVIDER_REQUEST_FAILED", false, 7, 0, {
            stage: "messages.list",
            reason: "GMAIL_RESPONSE_INVALID",
            status: 200,
            retryable: false,
            retriesAttempted: 0
          });
        }
        if (selectedGroup.index === 2) {
          throw new GmailSenderGroupResolutionError("INVALID_SENDER_IDENTITY", false);
        }
        if (selectedGroup.index === 3) return resolution(3, Math.min(limit, 4));
        return resolution(selectedGroup.index, limit);
      }
    });

    expect(result.candidates).toHaveLength(6);
    expect(result.failedCount).toBe(2);
    expect(result.failureReasonCounts.PROVIDER_REQUEST_FAILED).toBe(1);
    expect(result.providerFailureReasonCounts.GMAIL_RESPONSE_INVALID).toBe(1);
    expect(result.failureReasonCounts.INVALID_SENDER_IDENTITY).toBe(1);
    expect(result).toMatchObject({
      localFailureCount: 2,
      globalProviderFailureCount: 0,
      globalApplicationFailureCount: 0,
      classifiedFailureCount: 2,
      failureAccountingInvariant: true
    });
    expect(result.candidates.every((candidate) => candidate.groupIndex === 0 || candidate.groupIndex === 3)).toBe(true);
  });

  it("aborts the complete candidate set for a global authentication failure", async () => {
    const result = await resolveGmailCleanupSenderGroups({
      selectedGroups: Array.from({ length: 43 }, (_, index) => group(index)),
      requestedCount: 100,
      concurrency: 8,
      resolveGroup: async (selectedGroup, limit) => {
        if (selectedGroup.index === 3) {
          throw new GmailSenderGroupResolutionError("PROVIDER_REQUEST_FAILED", true, 12, 0, {
            stage: "messages.list",
            reason: "GMAIL_AUTHENTICATION_FAILED",
            status: 401,
            retryable: false,
            retriesAttempted: 0
          });
        }
        return resolution(selectedGroup.index, limit);
      }
    });

    expect(result.globalFailure).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.failedCount).toBe(1);
    expect(result.successfulCount).toBeGreaterThan(0);
    expect(result.attemptedCount).toBeGreaterThanOrEqual(4);
    expect(result.attemptedCount).toBeLessThan(43);
    expect(result.candidateResolutionMs).toBeGreaterThan(0);
    expect(result.previewSafetyCheckMs).toBeGreaterThan(0);
    expect(result).toMatchObject({
      globalProviderFailureCount: 1,
      globalApplicationFailureCount: 0,
      classifiedFailureCount: 1,
      failureAccountingInvariant: true
    });
  });

  it("records successful zero-candidate groups separately", async () => {
    const result = await resolveGmailCleanupSenderGroups({
      selectedGroups: [group(0), group(1)],
      requestedCount: 4,
      concurrency: 2,
      resolveGroup: async () => resolution(0, 0)
    });

    expect(result).toMatchObject({ successfulCount: 2, failedCount: 0, zeroSafeCandidateCount: 2 });
    expect(result.failureReasonCounts.NO_SAFE_CANDIDATES).toBe(2);
    expect(result.candidates).toEqual([]);
  });

  it("completes 100-candidate resolution with three messages.list 204 groups and deterministic redistribution", async () => {
    const groups = Array.from({ length: 43 }, (_, index) => group(index));
    const resolve = () =>
      resolveGmailCleanupSenderGroups({
        selectedGroups: groups,
        requestedCount: 100,
        concurrency: 8,
        resolveGroup: async (selectedGroup, limit) => {
          if (selectedGroup.index >= 3) return resolution(selectedGroup.index, limit);
          const client = new GmailTrashClient("test-token", {
            fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
            sleepImpl: async () => undefined
          });
          return client.resolveCleanupCandidatesForSender({
            senderAddress: selectedGroup.searchableIdentity,
            limit,
            participatedConversationIds: new Set(),
            now: new Date("2026-08-25T12:00:00Z")
          });
        }
      });

    const first = await resolve();
    const second = await resolve();

    expect(first).toMatchObject({
      selectedCount: 43,
      attemptedCount: 43,
      successfulCount: 43,
      failedCount: 0,
      zeroSafeCandidateCount: 3,
      contributingCount: 40,
      localFailureCount: 0,
      globalProviderFailureCount: 0,
      globalApplicationFailureCount: 0,
      classifiedFailureCount: 0,
      failureAccountingInvariant: true,
      globalFailure: false
    });
    expect(first.candidates).toHaveLength(100);
    expect(first.candidates.every((candidate) => candidate.groupIndex >= 3)).toBe(true);
    expect(first.contributions.reduce((total, count) => total + count, 0)).toBe(100);
    expect(first.providerFailureReasonCounts.GMAIL_RESPONSE_INVALID).toBe(0);
    expect(first.candidates).toEqual(second.candidates);
    expect(first.contributions).toEqual(second.contributions);
  });
});

describe("Gmail cleanup sender identities", () => {
  it.each([
    ["MIME display", "=?utf-8?b?V2lzaA==?= <offers@example.test>", "offers@example.test"],
    ["Unicode display", "Équipe <news@example.test>", "news@example.test"],
    ["quoted display", '"Example, Inc." <hello@example.test>', "hello@example.test"],
    ["apostrophe display", "O'Brien Deals <deals@example.test>", "deals@example.test"],
    ["parenthesized display", "Deals (Weekly) <weekly@example.test>", "weekly@example.test"],
    ["plus address", "Alerts <alerts+weekly@example.test>", "alerts+weekly@example.test"],
    ["missing display", "plain@example.test", "plain@example.test"]
  ])("derives the canonical address for %s", (_label, from, expected) => {
    expect(parseSender(from).address).toBe(expected);
  });

  it("keeps duplicate display names and same-domain senders distinct by canonical address", () => {
    const first = parseSender("Updates <first@example.test>");
    const second = parseSender("Updates <second@example.test>");

    expect(first.displayName).toBe(second.displayName);
    expect(new Set([first.address, second.address])).toEqual(new Set(["first@example.test", "second@example.test"]));
  });

  it("normalizes safe unusual addresses and rejects malformed scan fallbacks", () => {
    expect(normalizeGmailCleanupSenderIdentity("  Deals+West.O'Brien@Example.TEST ")).toBe(
      "deals+west.o'brien@example.test"
    );
    expect(normalizeGmailCleanupSenderIdentity("unknown@unknown.invalid")).toBeUndefined();
    expect(normalizeGmailCleanupSenderIdentity("not an address")).toBeUndefined();
    expect(normalizeGmailCleanupSenderIdentity("two@@example.test")).toBeUndefined();
    expect(normalizeGmailCleanupSenderIdentity("line\r\nbreak@example.test")).toBeUndefined();
  });

  it("quotes only the canonical address in Gmail search syntax", () => {
    const query = buildGmailSenderCleanupQuery({
      senderAddress: "Alerts+Weekly@Example.test",
      now: new Date("2026-08-25T12:00:00Z")
    });

    expect(query).toContain('from:("alerts+weekly@example.test")');
    expect(query).not.toContain("MIME");
    expect(() => buildGmailSenderCleanupQuery({ senderAddress: "unknown@unknown.invalid" })).toThrow(
      /Invalid canonical/
    );
  });

  it("keeps the fixed sender query bounded after maximum-length identity validation", () => {
    const local = "a".repeat(64);
    const domain = ["b".repeat(63), "c".repeat(63), "d".repeat(63), "e".repeat(61)].join(".");
    const address = `${local}@${domain}`;
    const query = buildGmailSenderCleanupQuery({
      senderAddress: address,
      now: new Date("2026-08-25T12:00:00Z")
    });

    expect(normalizeGmailCleanupSenderIdentity(address)).toBe(address);
    expect(query.length).toBeLessThan(512);
    expect(query).toContain(`from:("${address}")`);
  });
});

describe("Gmail group failure classification", () => {
  it("keeps sender-local list and metadata failures local", () => {
    const list = classifySenderGroupResolutionError(
      new GmailCandidateResolutionStageError("list", new GmailApiRequestError("bad query", false, 400), 17, 0)
    );
    const metadata = classifySenderGroupResolutionError(
      new GmailCandidateResolutionStageError("metadata", new GmailApiRequestError("gone", false, 404), 8, 11)
    );

    expect(list).toMatchObject({
      reason: "PROVIDER_REQUEST_FAILED",
      globalFailure: false,
      candidateResolutionMs: 17,
      providerFailure: {
        stage: "messages.list",
        reason: "GMAIL_INVALID_QUERY",
        status: 400,
        retryable: false,
        retriesAttempted: 0
      }
    });
    expect(metadata).toMatchObject({
      reason: "METADATA_RECHECK_FAILED",
      globalFailure: false,
      previewSafetyCheckMs: 11,
      providerFailure: { stage: "metadata recheck", reason: "GMAIL_NOT_FOUND", status: 404 }
    });
  });

  it("keeps authentication and exhausted transient failures global", () => {
    const authentication = classifySenderGroupResolutionError(
      new GmailCandidateResolutionStageError("list", new GmailApiRequestError("unauthorized", false, 401), 9, 0)
    );
    const outage = classifySenderGroupResolutionError(
      new GmailCandidateResolutionStageError("list", new GmailApiRequestError("retry exhausted", true, 503), 25, 0)
    );

    expect(authentication).toMatchObject({
      reason: "PROVIDER_REQUEST_FAILED",
      globalFailure: true,
      providerFailure: { reason: "GMAIL_AUTHENTICATION_FAILED", retryable: false }
    });
    expect(outage).toMatchObject({
      reason: "PROVIDER_REQUEST_FAILED",
      globalFailure: true,
      providerFailure: { reason: "GMAIL_PROVIDER_5XX", retryable: true }
    });
  });

  it("keeps an invalid messages.list success response local with its HTTP status", () => {
    const invalidResponse = classifySenderGroupResolutionError(
      new GmailCandidateResolutionStageError(
        "list",
        new GmailApiRequestError(
          "invalid response",
          false,
          200,
          "GMAIL_RESPONSE_INVALID",
          false,
          0
        ),
        6,
        0
      )
    );

    expect(invalidResponse).toMatchObject({
      reason: "PROVIDER_REQUEST_FAILED",
      globalFailure: false,
      providerFailure: {
        stage: "messages.list",
        reason: "GMAIL_RESPONSE_INVALID",
        status: 200,
        retryable: false,
        retriesAttempted: 0
      }
    });
  });

  it("keeps permission and policy failures global and unknown causes fail closed", () => {
    const policy = classifySenderGroupResolutionError(
      new GmailCandidateResolutionStageError(
        "list",
        new GmailApiRequestError("provider failed", false, 403, "GMAIL_DOMAIN_POLICY", false, 0),
        12,
        0
      )
    );
    const unknown = classifySenderGroupResolutionError(
      new GmailCandidateResolutionStageError("metadata", new Error("unexpected"), 2, 3)
    );

    expect(policy).toMatchObject({
      globalFailure: true,
      providerFailure: { reason: "GMAIL_DOMAIN_POLICY", status: 403, retriesAttempted: 0 }
    });
    expect(unknown).toMatchObject({
      globalFailure: true,
      providerFailure: {
        stage: "metadata recheck",
        reason: "GMAIL_UNKNOWN_PROVIDER_ERROR",
        status: undefined,
        retryable: false,
        retriesAttempted: 0
      }
    });
  });

  it("has no production legacy list-failure enum or wrapper path", () => {
    const source = [
      "src/lib/providers/gmail/gmail-api-client.ts",
      "src/lib/providers/gmail/group-resolution.ts",
      "src/lib/server/gmail-cleanup.ts"
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toContain(`GMAIL_${"LIST_FAILED"}`);
  });
});
