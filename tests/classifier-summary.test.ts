import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxReportView } from "@/components/product/InboxReportView";
import {
  countInvariantViolations,
  formatGmailLabelCategoryDiagnostic,
  formatMailboxClassifierSummary,
  formatSenderClassifierSummary,
  getClassifierSafetyChecks
} from "@/lib/domain/classifier-summary";
import { sanitizeReportForClient } from "@/lib/domain/report-sanitizer";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import type { InboxReport, NormalizedMessageMetadata } from "@/lib/domain/types";

const now = new Date("2026-08-25T12:00:00Z");

function message(overrides: Partial<NormalizedMessageMetadata> = {}): NormalizedMessageMetadata {
  return {
    providerMessageId: "sensitive-message-id",
    provider: "gmail",
    senderAddress: "sender@example.test",
    senderDisplayName: "Runway",
    senderDomain: "comms.runwayml.com",
    receivedAt: new Date("2024-01-01T00:00:00Z"),
    isRead: false,
    estimatedSize: 1000,
    providerCategory: "promotions",
    providerLabels: ["CATEGORY_PROMOTIONS"],
    hasListUnsubscribe: true,
    conversationId: "sensitive-conversation-id",
    ...overrides
  };
}

function diagnosticReport(messages = diagnosticMessages()): InboxReport {
  const aggregator = new StreamingReportAggregator({
    now,
    includeDiagnostics: true,
    participatedConversationIds: new Set(["participated-index-entry"])
  });
  aggregator.processBatch(messages);
  return aggregator.snapshot("gmail", false);
}

function diagnosticMessages() {
  return [
    message({ providerMessageId: "ready-1", listId: "private-list-id" }),
    message({ providerMessageId: "ready-2", precedence: "bulk" }),
    message({
      providerMessageId: "overlapping-protection",
      receivedAt: new Date("2026-08-20T00:00:00Z"),
      isStarred: true,
      isImportant: true,
      isSent: true
    })
  ];
}

function renderReport(report: InboxReport) {
  return renderToStaticMarkup(
    React.createElement(InboxReportView, {
      report,
      reportStale: false,
      source: "gmail-live",
      view: "senders",
      backHref: "/app",
      scanPerformance: {
        conversationIndexMs: 12,
        metadataMs: 34,
        subjectProtectionMs: 2,
        protectionClassificationMs: 5,
        aggregationMs: 3,
        durationMs: 54
      }
    })
  );
}

describe("development classifier summary UI", () => {
  it("renders mailbox and selected-sender copy controls when diagnostics are present", () => {
    const html = renderReport(diagnosticReport());

    expect(html).toContain("Classifier summary (development)");
    expect(html).toContain("Copy summary");
    expect(html).toContain("Copy Gmail diagnostic");
    expect(html).toContain("Classifier inspection (development)");
    expect(html).toContain("Copy sender summary");
    expect(html).toContain("Reason counts can overlap");
  });

  it("removes all diagnostics from production-sanitized report output", () => {
    const sanitized = sanitizeReportForClient(diagnosticReport(), false);
    const serialized = JSON.stringify(sanitized);
    const html = renderReport(sanitized);

    expect(sanitized.classifierDiagnostics).toBeUndefined();
    expect(sanitized.senders.every((sender) => sender.diagnostics === undefined)).toBe(true);
    expect(serialized).not.toMatch(/classifierDiagnostics|readyStrongSignals|messageSignals/);
    expect(html).not.toContain("Classifier summary (development)");
    expect(html).not.toContain("Copy sender summary");
  });

  it("visually flags nonzero safety checks without changing classification", () => {
    const report = diagnosticReport();
    report.classifierDiagnostics!.readyStrongSignals.withHardProtectionMessages = 1;

    const html = renderReport(report);
    expect(html).toContain('data-classifier-safety="warning"');
    expect(report.totals.cleanupCandidates).toBe(2);
  });
});

describe("classifier summary count semantics", () => {
  it("keeps final states non-overlapping while allowing protection reasons to overlap", () => {
    const report = diagnosticReport();
    const signals = report.classifierDiagnostics!.messageSignals;

    expect(report.totals.messages).toBe(
      report.totals.cleanupCandidates + report.totals.reviewMessages + report.totals.protectedMessages
    );
    expect(signals.starredMessages).toBe(1);
    expect(signals.importantMessages).toBe(1);
    expect(signals.recentMessages).toBe(1);
    expect(signals.sentMessages).toBe(1);
    expect(countInvariantViolations(report)).toBe(0);
  });

  it("calculates both Ready safety intersections", () => {
    const report = diagnosticReport();
    expect(getClassifierSafetyChecks(report)).toEqual({
      readyWithHardProtection: 0,
      readyWithoutStrongSignal: 0,
      countInvariantViolations: 0
    });

    report.classifierDiagnostics!.readyStrongSignals.withHardProtectionMessages = 2;
    report.classifierDiagnostics!.readyStrongSignals.withoutStrongSignalMessages = 1;
    expect(getClassifierSafetyChecks(report)).toMatchObject({
      readyWithHardProtection: 2,
      readyWithoutStrongSignal: 1
    });
  });

  it("counts an invalid mailbox state without mutating report values", () => {
    const report = diagnosticReport();
    report.totals.reviewMessages += 1;

    expect(countInvariantViolations(report)).toBe(1);
    expect(formatMailboxClassifierSummary(report)).toContain("Count invariant violations: 1");
  });
});

describe("copyable classifier text", () => {
  it("formats mailbox counts, recommendations, safety, conversation indexing, and existing performance", () => {
    const summary = formatMailboxClassifierSummary(diagnosticReport(), {
      conversationIndexMs: 12,
      metadataMs: 34,
      subjectProtectionMs: 2,
      protectionClassificationMs: 5,
      aggregationMs: 3,
      durationMs: 54
    });

    expect(summary).toContain("ORGANIZINBOX DEV CLASSIFIER SUMMARY");
    expect(summary).toContain("Total: 3");
    expect(summary).toContain("Ready: 2");
    expect(summary).toContain("Protected: 1");
    expect(summary).toContain("Participated conversations indexed: 1");
    expect(summary).toContain("Ready with hard protection: 0");
    expect(summary).toContain("Ready without strong per-message bulk evidence: 0");
    expect(summary).toContain("Metadata fetch: 34 ms");
    expect(summary).toContain("Transactional subject: 0");
    expect(summary).toContain("Security/account subject: 0");
    expect(summary).toContain("Subject protection: 2 ms");
    expect(summary).toContain("Personal category: unavailable");
    expect(summary).toContain("Promotions: unavailable");
    expect(summary).toContain("Social: unavailable");
  });

  it("formats the selected sender with only visible identity and aggregate values", () => {
    const summary = formatSenderClassifierSummary(diagnosticReport().senders[0]);

    expect(summary).toContain("ORGANIZINBOX DEV SENDER SUMMARY");
    expect(summary).toContain("Sender: Runway");
    expect(summary).toContain("Domain: comms.runwayml.com");
    expect(summary).toContain("Recommendation: High");
    expect(summary).toContain("Ready-message strong evidence");
    expect(summary).toContain("Ready without strong signal: 0");
  });

  it("excludes message-level data, raw content, credentials, and full sender addresses", () => {
    const report = diagnosticReport();
    const output = `${formatMailboxClassifierSummary(report)}\n${formatGmailLabelCategoryDiagnostic(report)}\n${formatSenderClassifierSummary(report.senders[0])}`;

    for (const sensitive of [
      "sensitive-message-id",
      "sensitive-conversation-id",
      "participated-index-entry",
      "private-list-id",
      "Private label",
      "sender@example.test",
      "Your receipt from Runway",
      "raw-header-value",
      "message body",
      "snippet content",
      "attachment.pdf",
      "oauth-access-token",
      "authorization-code"
    ]) {
      expect(output).not.toContain(sensitive);
    }
  });
});
