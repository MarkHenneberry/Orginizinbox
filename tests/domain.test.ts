import { describe, expect, it } from "vitest";
import { classifyMessage } from "@/lib/domain/classification";
import {
  assessMessage,
  categoryLabel,
  protectionReasonText,
  recommendationReasonText
} from "@/lib/domain/recommendations";
import { getAgeBand, indexSentConversation } from "@/lib/domain/safety";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import { buildCleanupReview } from "@/lib/domain/cleanup-review";
import type { InboxReport, NormalizedMessageMetadata } from "@/lib/domain/types";
import { getFixtureInboxReport } from "@/lib/fixtures/inbox";
import { serializePersistentScanRecord } from "@/lib/persistence/scan-records";
import type { MailboxProcessor } from "@/lib/providers/types";

const now = new Date("2026-08-25T12:00:00Z");
const dayMs = 24 * 60 * 60 * 1000;

function message(overrides: Partial<NormalizedMessageMetadata> = {}): NormalizedMessageMetadata {
  return {
    providerMessageId: "msg-1",
    provider: "gmail",
    senderAddress: "deals@fixture.example",
    senderDisplayName: "Fixture Deals",
    senderDomain: "fixture.example",
    receivedAt: daysAgo(400),
    isRead: false,
    estimatedSize: 1000,
    providerLabels: ["CATEGORY_PROMOTIONS"],
    providerCategory: "promotions",
    hasListUnsubscribe: true,
    isStarred: false,
    isImportant: false,
    conversationId: "conversation-1",
    ...overrides
  };
}

function report(messages: NormalizedMessageMetadata[], participatedConversationIds = new Set<string>()): InboxReport {
  const aggregator = new StreamingReportAggregator({ now, participatedConversationIds });
  aggregator.processBatch(messages);
  return aggregator.snapshot("gmail", false);
}

describe("metadata-only mail classes", () => {
  it("uses only normalized provider labels and allowlisted bulk metadata", () => {
    expect(classifyMessage(message({ providerCategory: "promotions" }))).toBe("PROMOTIONAL");
    expect(classifyMessage(message({ providerCategory: "social", hasListUnsubscribe: false }))).toBe("SOCIAL_AUTOMATION");
    expect(classifyMessage(message({ providerCategory: "updates", hasListUnsubscribe: false }))).toBe("ACCOUNT_OR_TRANSACTIONAL");
    expect(classifyMessage(message({ providerCategory: "personal", hasListUnsubscribe: false }))).toBe("PERSONAL");
    expect(classifyMessage(message({ providerCategory: undefined, listId: "list.example", hasListUnsubscribe: false }))).toBe("BULK_NEWSLETTER");
    expect(classifyMessage(message({ providerCategory: undefined, hasListUnsubscribe: false }))).toBe("UNKNOWN");
  });

  it("does not infer receipts, security, or meaning from sender text", () => {
    expect(
      classifyMessage(message({ senderAddress: "security-invoice@bank.test", providerCategory: undefined, hasListUnsubscribe: false }))
    ).toBe("UNKNOWN");
  });

  it("uses the conservative user-facing taxonomy", () => {
    expect(categoryLabel("BULK_NEWSLETTER")).toBe("Newsletters & bulk mail");
    expect(categoryLabel("ACCOUNT_OR_TRANSACTIONAL")).toBe("Account & transactional");
  });
});

describe("age bands and hard protections", () => {
  it("applies exact 30, 180, and 365 day boundaries", () => {
    expect(getAgeBand(daysAgo(29), now)).toBe("recent");
    expect(getAgeBand(daysAgo(30), now)).toBe("current");
    expect(getAgeBand(daysAgo(179), now)).toBe("current");
    expect(getAgeBand(daysAgo(180), now)).toBe("old");
    expect(getAgeBand(daysAgo(364), now)).toBe("old");
    expect(getAgeBand(daysAgo(365), now)).toBe("very_old");
  });

  it.each([
    ["PROTECTED_STARRED", { isStarred: true }],
    ["PROTECTED_IMPORTANT", { isImportant: true }],
    ["PROTECTED_RECENT", { receivedAt: daysAgo(2) }],
    ["PROTECTED_PERSONAL", { providerCategory: "personal", hasListUnsubscribe: false }],
    ["PROTECTED_SENT", { isSent: true }],
    ["PROTECTED_DRAFT", { isDraft: true }]
  ] as const)("applies %s", (reason, overrides) => {
    expect(assessMessage(message(overrides), { now }).protectionReasons).toContain(reason);
  });

  it("protects explicitly protected addresses and domains", () => {
    expect(
      assessMessage(message(), { now, protectedSenders: new Set(["deals@fixture.example"]) }).protectionReasons
    ).toContain("PROTECTED_SENDER");
    expect(
      assessMessage(message(), { now, protectedSenders: new Set(["fixture.example"]) }).protectionReasons
    ).toContain("PROTECTED_SENDER");
  });

  it("protects incoming mail in a conversation where the user sent a message", () => {
    const participatedConversationIds = new Set<string>();
    indexSentConversation({ isSent: true, conversationId: "participated" }, participatedConversationIds);
    indexSentConversation({ isSent: false, conversationId: "unrelated" }, participatedConversationIds);
    const assessed = assessMessage(message({ conversationId: "participated" }), {
      now,
      participatedConversationIds
    });
    expect(assessed.protectionReasons).toContain("PROTECTED_USER_PARTICIPATED_CONVERSATION");
    expect(assessed.eligibleForCleanup).toBe(false);
    expect(assessMessage(message({ conversationId: "unrelated" }), { now, participatedConversationIds }).isProtected).toBe(false);
  });

  it("preserves multiple protection reasons on the same message", () => {
    const assessed = assessMessage(message({ isStarred: true, isImportant: true, receivedAt: daysAgo(3) }), { now });
    expect(assessed.protectionReasons).toEqual(
      expect.arrayContaining(["PROTECTED_STARRED", "PROTECTED_IMPORTANT", "PROTECTED_RECENT"])
    );
  });
});

describe("message eligibility", () => {
  it("requires age, strong bulk evidence, and no hard protection", () => {
    expect(assessMessage(message(), { now }).eligibleForCleanup).toBe(true);
    expect(assessMessage(message({ receivedAt: daysAgo(100) }), { now }).eligibleForCleanup).toBe(false);
    expect(
      assessMessage(message({ providerCategory: undefined, hasListUnsubscribe: false }), { now }).eligibleForCleanup
    ).toBe(false);
    expect(assessMessage(message({ isImportant: true }), { now }).eligibleForCleanup).toBe(false);
  });

  it("treats every required bulk header and Promotions as strong evidence", () => {
    const variants: Array<Partial<NormalizedMessageMetadata>> = [
      { providerCategory: undefined, hasListUnsubscribe: false, listId: "list.example" },
      { providerCategory: undefined, hasListUnsubscribe: true },
      { providerCategory: undefined, hasListUnsubscribe: false, precedence: "bulk" },
      { providerCategory: undefined, hasListUnsubscribe: false, precedence: "list" },
      { providerCategory: "promotions", hasListUnsubscribe: false }
    ];
    variants.forEach((variant) => expect(assessMessage(message(variant), { now }).eligibleForCleanup).toBe(true));
  });

  it("keeps user labels soft and no-reply style supporting only", () => {
    const labeled = assessMessage(message({ userLabels: ["Saved"] }), { now });
    expect(labeled.reviewSignals).toContain("USER_LABEL_PRESENT");
    expect(labeled.protectionReasons).not.toContain("PROTECTED_SENDER");

    const noReply = assessMessage(
      message({ senderAddress: "no-reply@unknown.test", providerCategory: undefined, hasListUnsubscribe: false }),
      { now }
    );
    expect(noReply.cleanupSignals).toContain("NOREPLY_STYLE_SENDER");
    expect(noReply.eligibleForCleanup).toBe(false);

    const autoSubmitted = assessMessage(
      message({ providerCategory: undefined, hasListUnsubscribe: false, autoSubmitted: "auto-generated" }),
      { now }
    );
    expect(autoSubmitted.cleanupSignals).toContain("AUTO_SUBMITTED");
    expect(autoSubmitted.eligibleForCleanup).toBe(false);
  });
});

describe("sender recommendations and mixed groups", () => {
  it("gives recurring old mail with strong bulk evidence High", () => {
    const inbox = report(Array.from({ length: 3 }, (_, index) => message({ providerMessageId: `bulk-${index}` })));
    expect(inbox.senders[0].cleanupConfidence).toBe("high");
    expect(inbox.senders[0].cleanupCandidateCount).toBe(3);
  });

  it("requires independent evidence, volume, and age for Very High", () => {
    const inbox = report(
      Array.from({ length: 30 }, (_, index) =>
        message({ providerMessageId: `bulk-${index}`, listId: "fixture.list", hasListUnsubscribe: true })
      )
    );
    expect(inbox.senders[0].cleanupConfidence).toBe("very_high");
    expect(inbox.senders[0].reasonCodes).toEqual(
      expect.arrayContaining(["MULTIPLE_STRONG_BULK_SIGNALS", "SUBSTANTIAL_ELIGIBLE_VOLUME", "RECURRING_SENDER"])
    );
  });

  it("never lets a sender recommendation override protected messages", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message({
        providerMessageId: `mixed-${index}`,
        isStarred: index === 0,
        isImportant: index === 1,
        receivedAt: index === 2 ? daysAgo(5) : daysAgo(400)
      })
    );
    const inbox = report(messages);
    expect(inbox.senders[0].cleanupConfidence).toBe("high");
    expect(inbox.senders[0].protectedMessages).toBe(3);
    expect(inbox.senders[0].cleanupCandidateCount).toBe(7);
  });

  it("makes a significant protected subset Review and cleanup-ineligible", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message({ providerMessageId: `mixed-${index}`, isImportant: index < 4 })
    );
    const sender = report(messages).senders[0];
    expect(sender.cleanupConfidence).toBe("review");
    expect(sender.cleanupCandidateCount).toBe(0);
    expect(sender.reasonCodes).toContain("SIGNIFICANT_PROTECTED_SUBSET");
  });

  it("keeps Social, Updates, user-labeled, and unknown high-volume mail out of High", () => {
    const scenarios = [
      { providerCategory: "social" as const, hasListUnsubscribe: false },
      { providerCategory: "updates" as const, hasListUnsubscribe: false },
      { providerCategory: "promotions" as const, hasListUnsubscribe: false, userLabels: ["Saved"] },
      { providerCategory: undefined, hasListUnsubscribe: false, senderAddress: "no-reply@unknown.test" }
    ];
    scenarios.forEach((overrides, scenarioIndex) => {
      const sender = report(
        Array.from({ length: 1000 }, (_, index) =>
          message({ ...overrides, providerMessageId: `scenario-${scenarioIndex}-${index}`, receivedAt: daysAgo(800), estimatedSize: 10_000_000 })
        )
      ).senders[0];
      expect(["keep", "review"]).toContain(sender.cleanupConfidence);
      expect(sender.cleanupCandidateCount).toBe(0);
    });
  });

  it("does not merge different addresses that share a display name", () => {
    const inbox = report([
      message({ providerMessageId: "one", senderAddress: "one@example.test", senderDisplayName: "Same" }),
      message({ providerMessageId: "two", senderAddress: "two@example.test", senderDisplayName: "Same" })
    ]);
    expect(inbox.senders).toHaveLength(2);
  });
});

describe("streaming report and explanations", () => {
  it("produces equivalent totals across bounded batches", () => {
    const messages = Array.from({ length: 31 }, (_, index) => message({ providerMessageId: `stream-${index}` }));
    const oneBatch = report(messages);
    const aggregator = new StreamingReportAggregator({ now });
    for (let index = 0; index < messages.length; index += 5) aggregator.processBatch(messages.slice(index, index + 5));
    expect(aggregator.snapshot("gmail", false).totals).toEqual(oneBatch.totals);
  });

  it("uses stable reason-code copy without generated confidence percentages", () => {
    expect(recommendationReasonText("HAS_LIST_ID")).toBe("Mailing-list headers found");
    expect(protectionReasonText("PROTECTED_RECENT")).toBe("Recent messages are protected");
  });

  it("keeps cleanup totals bounded and eligible-byte estimates protection-aware", () => {
    const inbox = report([
      ...Array.from({ length: 3 }, (_, index) => message({ providerMessageId: `eligible-${index}`, estimatedSize: 1000 })),
      message({ providerMessageId: "protected", isImportant: true, estimatedSize: 1_000_000 })
    ]);
    expect(inbox.totals.cleanupCandidates).toBe(3);
    expect(inbox.totals.estimatedRecoverableBytes).toBe(3000);
    expect(inbox.totals.cleanupCandidates).toBeLessThanOrEqual(inbox.totals.messages);
  });

  it("includes all conservative fixture scenarios", () => {
    const inbox = getFixtureInboxReport();
    const byName = new Map(inbox.senders.map((sender) => [sender.displayName, sender]));
    expect(byName.get("Daily Brief")?.cleanupConfidence).toBe("very_high");
    expect(byName.get("Social Circle")?.cleanupConfidence).toBe("review");
    expect(byName.get("Account Updates")?.cleanupConfidence).toBe("review");
    expect(byName.get("Avery Morgan")?.cleanupConfidence).toBe("keep");
    expect(byName.get("Mixed List")?.protectedMessages).toBeGreaterThan(0);
    expect(byName.get("Unknown Archive")?.cleanupConfidence).toBe("keep");
  });
});

describe("cleanup review consistency", () => {
  it("includes only category counts authorized by High or Very High groups", () => {
    const inbox = report(Array.from({ length: 5 }, (_, index) => message({ providerMessageId: `promo-${index}` })));
    const review = buildCleanupReview(inbox, "gmail-live");
    expect(review.selectedUniqueCleanupCount).toBe(inbox.totals.cleanupCandidates);
    expect(review.groups.every((group) => group.selectedCount > 0)).toBe(true);
  });

  it("rejects impossible cleanup totals", () => {
    const inbox = report([message()]);
    inbox.totals.cleanupCandidates = inbox.totals.messages + 1;
    expect(() => buildCleanupReview(inbox, "gmail-live")).toThrow(/cleanup candidates exceed total messages/);
  });
});

describe("privacy-safe architecture", () => {
  it("serializes persistent scan records without mailbox-derived fields", () => {
    const serialized = JSON.stringify(
      serializePersistentScanRecord({
        id: "scan_123",
        userId: "user_123",
        providerConnectionId: "connection_123",
        provider: "gmail",
        status: "running",
        startedAt: "2026-08-25T12:00:00.000Z"
      })
    );
    expect(serialized).not.toMatch(/sender|messageId|subject|body|attachment|ranking|fixture\.example/i);
  });

  it("does not expose dangerous mailbox operations", () => {
    const allowedMethods = ["getMailboxProfile", "scanMetadata", "searchCleanupGroup", "moveApprovedMessagesToTrash", "disconnect"];
    const dangerousMethods = ["sendEmail", "createDraft", "reply", "forward", "getFullMessage", "getMessageBody", "downloadAttachment", "permanentlyDelete", "deleteForever", "expungeMailbox"];
    const processorShape = Object.fromEntries(allowedMethods.map((method) => [method, async () => undefined])) as unknown as MailboxProcessor;
    expect(Object.keys(processorShape).sort()).toEqual(allowedMethods.sort());
    dangerousMethods.forEach((method) => expect(method in processorShape).toBe(false));
  });
});

function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * dayMs);
}
