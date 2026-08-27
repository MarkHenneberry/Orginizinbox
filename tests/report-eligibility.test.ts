import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxReportView } from "@/components/product/InboxReportView";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import type { InboxReport, NormalizedMessageMetadata } from "@/lib/domain/types";
import { buildCleanupSenderGroups } from "@/lib/providers/gmail/cleanup-candidates";

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

function buildReport(messages: NormalizedMessageMetadata[]): InboxReport {
  const aggregator = new StreamingReportAggregator({ now });
  aggregator.processBatch(messages);
  return aggregator.snapshot("gmail", false);
}

function renderSenders(report: InboxReport) {
  return renderToStaticMarkup(
    React.createElement(InboxReportView, {
      report,
      reportStale: false,
      source: "gmail-live",
      view: "senders",
      backHref: "/app"
    })
  );
}

describe("final report eligibility buckets", () => {
  it("reconciles Total as Ready + Review + Protected at every aggregate level", () => {
    const inbox = buildReport(mixedSenderMessages());
    const sender = inbox.senders[0];

    expect(sender.totalMessages).toBe(10);
    expect(sender.cleanupCandidateCount).toBe(5);
    expect(sender.reviewMessages).toBe(2);
    expect(sender.protectedMessages).toBe(3);
    expect(sender.totalMessages).toBe(
      sender.cleanupCandidateCount + sender.reviewMessages + sender.protectedMessages
    );
    expect(inbox.totals.messages).toBe(
      inbox.totals.cleanupCandidates + inbox.totals.reviewMessages + inbox.totals.protectedMessages
    );
    inbox.categories.forEach((category) => {
      expect(category.totalMessages).toBe(
        category.cleanupCandidateCount + category.reviewMessages + category.protectedMessages
      );
    });
  });

  it("shows all three states for a mixed sender", () => {
    const html = renderSenders(buildReport(mixedSenderMessages()));
    expect(html).toContain("Suggested");
    expect(html).toContain("Review");
    expect(html).toContain("Protected");
    expect(html).toContain("Review 5 emails");
  });

  it("does not represent protected or review messages as Ready", () => {
    const sender = buildReport(mixedSenderMessages()).senders[0];
    expect(sender.cleanupCandidateCount).toBe(5);
    expect(sender.cleanupCandidateCount).toBeLessThan(sender.totalMessages);
    expect(sender.cleanupCandidateCount + sender.reviewMessages + sender.protectedMessages).toBe(10);
  });
});

describe("sender cleanup CTA eligibility", () => {
  it("shows a passive state for Keep with Ready zero", () => {
    const inbox = buildReport(
      Array.from({ length: 3 }, (_, index) =>
        message({
          providerMessageId: `personal-${index}`,
          providerCategory: "personal",
          providerLabels: ["CATEGORY_PERSONAL"],
          hasListUnsubscribe: false
        })
      )
    );
    expect(inbox.senders[0].cleanupConfidence).toBe("keep");
    expect(inbox.senders[0].cleanupCandidateCount).toBe(0);

    const html = renderSenders(inbox);
    expect(html).toContain("Nothing recommended for cleanup");
    expect(html).not.toContain('href="/app/cleanup"');
  });

  it("shows a passive state for a Review recommendation", () => {
    const inbox = buildReport(
      Array.from({ length: 3 }, (_, index) =>
        message({
          providerMessageId: `social-${index}`,
          providerCategory: "social",
          providerLabels: ["CATEGORY_SOCIAL"],
          hasListUnsubscribe: false
        })
      )
    );
    expect(inbox.senders[0].cleanupConfidence).toBe("review");
    expect(inbox.senders[0].reviewMessages).toBe(3);

    const html = renderSenders(inbox);
    expect(html).toContain("Nothing recommended for cleanup");
    expect(html).not.toContain('href="/app/cleanup"');
  });

  it("shows the Ready subset CTA for High", () => {
    const inbox = buildReport(
      Array.from({ length: 3 }, (_, index) => message({ providerMessageId: `high-${index}` }))
    );
    expect(inbox.senders[0].cleanupConfidence).toBe("high");
    expect(renderSenders(inbox)).toContain("Review 3 emails");
  });

  it("shows the Ready subset CTA for Very High", () => {
    const inbox = buildReport(
      Array.from({ length: 30 }, (_, index) =>
        message({ providerMessageId: `very-high-${index}`, listId: "offers.example" })
      )
    );
    expect(inbox.senders[0].cleanupConfidence).toBe("very_high");
    expect(renderSenders(inbox)).toContain("Review 30 emails");
  });

  it("passes only the Ready count into cleanup group selection", () => {
    const inbox = buildReport(mixedSenderMessages());
    const group = buildCleanupSenderGroups(inbox.senders)[0];

    expect(group.totalMessages).toBe(10);
    expect(group.cleanupCandidateCount).toBe(5);
    expect(group.reviewMessages).toBe(2);
    expect(group.protectedMessages).toBe(3);
    expect(renderSenders(inbox)).not.toContain("Review 10 emails");
  });
});

function mixedSenderMessages(): NormalizedMessageMetadata[] {
  const ready = Array.from({ length: 5 }, (_, index) =>
    message({ providerMessageId: `ready-${index}` })
  );
  const review = Array.from({ length: 2 }, (_, index) =>
    message({
      providerMessageId: `review-${index}`,
      providerCategory: undefined,
      providerLabels: [],
      hasListUnsubscribe: false
    })
  );
  const protectedMessages = Array.from({ length: 3 }, (_, index) =>
    message({ providerMessageId: `protected-${index}`, isImportant: true })
  );
  return [...ready, ...review, ...protectedMessages];
}
