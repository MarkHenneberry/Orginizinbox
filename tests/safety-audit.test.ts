import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxReportView } from "@/components/product/InboxReportView";
import { assessMessage } from "@/lib/domain/recommendations";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import type { InboxReport, NormalizedMessageMetadata } from "@/lib/domain/types";
import {
  isEligibleGmailApiCleanupCandidate,
  type GmailMinimalMessageMetadata
} from "@/lib/providers/gmail/cleanup-candidates";
import {
  gmailFetchQuery,
  gmailHeaderAllowlist,
  normalizeGmailMessage
} from "@/lib/providers/gmail/metadata";

const now = new Date("2026-08-25T12:00:00Z");

function message(overrides: Partial<NormalizedMessageMetadata> = {}): NormalizedMessageMetadata {
  return {
    providerMessageId: "message-1",
    provider: "gmail",
    senderAddress: "sender@example.test",
    senderDisplayName: "Example Sender",
    senderDomain: "example.test",
    receivedAt: new Date("2024-01-01T00:00:00Z"),
    isRead: false,
    estimatedSize: 1000,
    providerCategory: "promotions",
    providerLabels: ["CATEGORY_PROMOTIONS"],
    hasListUnsubscribe: true,
    ...overrides
  };
}

function report(messages: NormalizedMessageMetadata[], includeDiagnostics = false): InboxReport {
  const aggregator = new StreamingReportAggregator({ now, includeDiagnostics });
  aggregator.processBatch(messages);
  return aggregator.snapshot("gmail", false);
}

function gmailApiMessage(overrides: Partial<GmailMinimalMessageMetadata> = {}): GmailMinimalMessageMetadata {
  return {
    id: "native-message-id",
    threadId: "thread-1",
    labelIds: ["CATEGORY_PROMOTIONS"],
    internalDate: String(new Date("2024-01-01T00:00:00Z").getTime()),
    headers: [
      { name: "From", value: "Example Sender <sender@example.test>" },
      { name: "List-Id", value: "offers.example" }
    ],
    ...overrides
  };
}

describe("Gmail starred-message protection", () => {
  it("fetches flags and recognizes ImapFlow's normal and case-varied Flagged values", () => {
    expect(gmailFetchQuery.flags).toBe(true);
    expect(normalizeGmailMessage({ flags: new Set(["\\Flagged"]) }).isStarred).toBe(true);
    expect(normalizeGmailMessage({ flags: new Set(["\\fLaGgEd"]) }).isStarred).toBe(true);
    expect(normalizeGmailMessage({ flags: new Set(["\\Seen"]), labels: ["CATEGORY_PROMOTIONS"] }).isStarred).toBe(false);
  });

  it("also recognizes Gmail's normalized Starred label without relying on it", () => {
    expect(normalizeGmailMessage({ flags: new Set(), labels: ["\\Starred"] }).isStarred).toBe(true);
  });

  it("keeps a very old starred bulk message out of Ready", () => {
    const assessed = assessMessage(message({ isStarred: true }), { now });

    expect(assessed.cleanupSignals).toEqual(
      expect.arrayContaining(["HAS_LIST_UNSUBSCRIBE", "CATEGORY_PROMOTIONS"])
    );
    expect(assessed.protectionReasons).toContain("PROTECTED_STARRED");
    expect(assessed.eligibleForCleanup).toBe(false);
  });

  it("protects only the starred member of an otherwise High sender group", () => {
    const sender = report([
      message({ providerMessageId: "bulk-1" }),
      message({ providerMessageId: "bulk-2" }),
      message({ providerMessageId: "starred", isStarred: true })
    ]).senders[0];

    expect(sender.cleanupConfidence).toBe("high");
    expect(sender.cleanupCandidateCount).toBe(2);
    expect(sender.reviewMessages).toBe(0);
    expect(sender.protectedMessages).toBe(1);
  });
});

describe("message-level cleanup evidence isolation", () => {
  it("does not transfer one message's strong evidence to ambiguous messages from the same sender", () => {
    const sender = report([
      message({ providerMessageId: "strong-1" }),
      message({ providerMessageId: "strong-2", listId: "offers.example" }),
      message({
        providerMessageId: "ambiguous",
        providerCategory: undefined,
        providerLabels: [],
        hasListUnsubscribe: false
      })
    ]).senders[0];

    expect(sender.cleanupConfidence).toBe("high");
    expect(sender.cleanupCandidateCount).toBe(2);
    expect(sender.reviewMessages).toBe(1);
    expect(sender.protectedMessages).toBe(0);
  });

  it("keeps recurring old unread mail with no per-message strong evidence out of Ready", () => {
    const sender = report(
      Array.from({ length: 10 }, (_, index) =>
        message({
          providerMessageId: `ambiguous-${index}`,
          providerCategory: undefined,
          providerLabels: [],
          hasListUnsubscribe: false
        })
      )
    ).senders[0];

    expect(sender.cleanupCandidateCount).toBe(0);
    expect(sender.reviewMessages).toBe(10);
  });

  it("keeps an Updates message in Review beside individually eligible newsletter messages", () => {
    const sender = report([
      message({ providerMessageId: "newsletter-1", providerCategory: undefined, providerLabels: [], listId: "list.example" }),
      message({ providerMessageId: "newsletter-2", providerCategory: undefined, providerLabels: [], listId: "list.example" }),
      message({
        providerMessageId: "account-update",
        providerCategory: "updates",
        providerLabels: ["CATEGORY_UPDATES"],
        hasListUnsubscribe: false
      })
    ]).senders[0];

    expect(sender.cleanupConfidence).toBe("high");
    expect(sender.cleanupCandidateCount).toBe(2);
    expect(sender.reviewMessages).toBe(1);
  });
});

describe("development classifier diagnostics", () => {
  it("reports aggregate safe-signal counts and no Ready message without strong evidence", () => {
    const inbox = report(
      [
        message({ providerMessageId: "ready-1", listId: "offers.example" }),
        message({ providerMessageId: "ready-2", precedence: "bulk" }),
        message({ providerMessageId: "protected", isStarred: true }),
        message({
          providerMessageId: "review",
          providerCategory: "updates",
          providerLabels: ["CATEGORY_UPDATES"],
          hasListUnsubscribe: false
        })
      ],
      true
    );
    const sender = inbox.senders[0];

    expect(sender.cleanupConfidence).toBe("high");
    expect(sender.diagnostics).toEqual({
      totalMessages: 4,
      readyMessages: 2,
      reviewMessages: 1,
      protectedMessages: 1,
      messageSignals: {
        starredMessages: 1,
        importantMessages: 0,
        recentMessages: 0,
        sentMessages: 0,
        draftMessages: 0,
        personalMessages: 0,
        participatedConversationMessages: 0,
        userLabelMessages: 0,
        protectedSenderMessages: 0,
        transactionalSubjectMessages: 0,
        securityAccountSubjectMessages: 0,
        listIdMessages: 1,
        listUnsubscribeMessages: 3,
        precedenceBulkOrListMessages: 1,
        promotionsMessages: 3,
        updatesMessages: 1,
        socialMessages: 0,
        autoSubmittedMessages: 0,
        noReplyStyleMessages: 0,
        oldMessages: 4,
        veryOldMessages: 4,
        unreadMessages: 4
      },
      readyStrongSignals: {
        listIdMessages: 1,
        listUnsubscribeMessages: 2,
        precedenceBulkOrListMessages: 1,
        promotionsMessages: 2,
        withHardProtectionMessages: 0,
        withoutStrongSignalMessages: 0
      }
    });

    const html = renderToStaticMarkup(
      React.createElement(InboxReportView, {
        report: inbox,
        reportStale: false,
        source: "gmail-live",
        view: "senders",
        backHref: "/app"
      })
    );
    expect(html).toContain("Classifier inspection (development)");
    expect(html).toContain("Suggested without a strong signal");
    expect(html).not.toContain("ready-1");
    expect(html).not.toContain("thread-1");
    expect(html).not.toContain("offers.example");
    expect(html).not.toContain("Your receipt from Runway");
  });

  it("omits diagnostics unless the caller explicitly enables them", () => {
    expect(report([message()]).senders[0].diagnostics).toBeUndefined();
  });
});

describe("mutation-time protection and metadata privacy", () => {
  it("excludes a message that became starred after a scan marked it eligible", () => {
    expect(assessMessage(message(), { now }).eligibleForCleanup).toBe(true);
    expect(
      isEligibleGmailApiCleanupCandidate(gmailApiMessage({ labelIds: ["CATEGORY_PROMOTIONS", "STARRED"] }), {
        expectedSenderAddress: "sender@example.test",
        participatedConversationIds: new Set(),
        now
      })
    ).toBe(false);
  });

  it("allows Subject only inside the bounded metadata header fetch", () => {
    expect(gmailHeaderAllowlist).toContain("Subject");
    expect(gmailFetchQuery.headers).toContain("Subject");
    expect(JSON.stringify(gmailFetchQuery)).not.toMatch(/bodyParts|bodyStructure|envelope|source|attachment/i);
  });
});
