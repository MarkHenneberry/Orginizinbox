import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxReportView } from "@/components/product/InboxReportView";
import {
  COPY_FEEDBACK_DURATION_MS,
  copyFeedbackLabel,
  reduceCopyFeedback,
  type CopyFeedbackState
} from "@/lib/domain/copy-feedback";
import {
  createOutlookScanDiagnostic,
  formatOutlookScanSummary
} from "@/lib/domain/outlook-scan-summary";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import type { InboxReport, OutlookScanDiagnostic } from "@/lib/domain/types";

describe("copyable Outlook scan diagnostic", () => {
  it("formats the requested aggregate sections and counts", () => {
    const report = outlookReport();
    const summary = formatOutlookScanSummary(report, diagnostic());

    expect(summary).toContain("ORGANIZINBOX DEV OUTLOOK SCAN SUMMARY");
    expect(summary).toContain("Provider: Microsoft");
    expect(summary).toContain("Messages scanned: 10,000");
    expect(summary).toContain("Graph pages: 42");
    expect(summary).toContain("Graph requests: 45");
    expect(summary).toContain("Scan mode: full");
    expect(summary).toContain("Folders scanned: 6");
    expect(summary).toContain("Max concurrent Graph requests: 2");
    expect(summary).toContain("Metadata requests: 22");
    expect(summary).toContain("Header-enrichment requests: 0");
    expect(summary).toContain("Messages enriched: 0");
    expect(summary).toContain("Main message page size: 100");
    expect(summary).toContain("Main message page sizes: 100");
    expect(summary).toContain("Main message pages: 40");
    expect(summary).toContain("Main message page fallbacks: 0");
    expect(summary).toContain("429 waits: 250 ms");
    expect(summary).toContain("Peak per-scan memory estimate: 3.5 MB");
    expect(summary).toContain("Scan duration: 12,345 ms");
    expect(summary).toContain("Messages/sec: 810.04");
    expect(summary).toContain("Suggested: 3");
    expect(summary).toContain("Review: 0");
    expect(summary).toContain("Protected: 1");
    expect(summary).toContain("Sender groups: 1");
    expect(summary).toContain("Recent: 7");
    expect(summary).toContain("Important: 6");
    expect(summary).toContain("Sent excluded: 5");
    expect(summary).toContain("Draft excluded: 4");
    expect(summary).toContain("Deleted Items excluded: 3");
    expect(summary).toContain("Transactional Subject protection: 2");
    expect(summary).toContain("Security/account Subject protection: 1");
    expect(summary).toContain("Conversation identity: available");
    expect(summary).toContain("Categories: unavailable");
    expect(summary).toContain("401 failures: 1");
    expect(summary).toContain("403 failures: 2");
    expect(summary).toContain("429 throttles: 3");
    expect(summary).toContain("5xx failures: 4");
    expect(summary).toContain("Other 4xx failures: 6");
    expect(summary).toContain("Last other 4xx status: 400");
    expect(summary).toContain("Last other 4xx category: bad_request");
    expect(summary).toContain("Last other 4xx operation: main_message_scan");
    expect(summary).toContain("Last non-HTTP failure operation: main_message_scan");
    expect(summary).toContain("Last non-HTTP failure category: invalid_json");
    expect(summary).toContain("Retries: 5");
    expect(summary).toContain("Result\nSUCCESS");
  });

  it("contains explicit privacy assertions and excludes sensitive snapshot data", () => {
    const report = outlookReport();
    const summary = formatOutlookScanSummary(report, {
      ...diagnostic(),
      snapshotId: "sensitive-scan-id"
    });

    for (const assertion of [
      "Body fetched: no",
      "BodyPreview fetched: no",
      "Attachments fetched: no",
      "Raw Subject persisted: no",
      "Microsoft message IDs persisted: no",
      "Headers persisted: no",
      "Tokens exposed: no"
    ]) expect(summary).toContain(assertion);

    for (const sensitive of [
      "sensitive-scan-id",
      "sensitive-message-id",
      "sensitive-conversation-id",
      "private-sender@example.test",
      "Private Subject",
      "raw-private-header",
      "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=private",
      "oauth-access-token",
      "provider response body"
    ]) expect(summary).not.toContain(sensitive);
  });

  it("formats IMAP transport, batching, command, error, memory, and safety totals", () => {
    const snapshot = createOutlookScanDiagnostic({
      ...progress("imap-scan", 9_992),
      outlookTransport: "imap",
      imapFolders: 14,
      imapMetadataBatches: 48,
      imapCommands: 83,
      imapRetries: 1,
      imapErrors: 0,
      imapPeakScanMemoryMb: 7.25
    });
    const summary = formatOutlookScanSummary(outlookReport(), snapshot);

    expect(summary).toContain("Transport: imap");
    expect(summary).toContain("Messages scanned: 9,992");
    expect(summary).toContain("IMAP folders: 14");
    expect(summary).toContain("IMAP metadata batches: 48");
    expect(summary).toContain("IMAP commands/round trips: 83");
    expect(summary).toContain("IMAP retries: 1");
    expect(summary).toContain("IMAP errors: 0");
    expect(summary).toContain("IMAP peak memory estimate: 7.25 MB");
    expect(summary).toContain("Safety invariant violations: 0");
  });

  it("renders the development-only Outlook copy control for an Outlook snapshot", () => {
    const html = renderToStaticMarkup(React.createElement(InboxReportView, {
      report: outlookReport(),
      reportStale: false,
      source: "microsoft-live",
      view: "overview",
      backHref: "/app",
      outlookScanDiagnostic: diagnostic()
    }));

    expect(html).toContain("Copy Outlook scan summary");
    expect(html).toContain("Outlook scan diagnostic");
    expect(html).toContain("ORGANIZINBOX DEV OUTLOOK SCAN SUMMARY");
  });

  it("renders the normal Review cleanup action when Outlook cleanup is development-enabled", () => {
    const html = renderToStaticMarkup(React.createElement(InboxReportView, {
      report: outlookReport(),
      reportStale: false,
      source: "microsoft-live",
      view: "overview",
      backHref: "/app",
      outlookScanDiagnostic: diagnostic(),
      outlookCleanupEnabled: true
    }));

    expect(html).toContain("Review cleanup");
    expect(html).not.toContain("Run 5-message move + restore proof");
  });
});

describe("Outlook diagnostic snapshot and copy feedback reset", () => {
  it("replaces every scan-specific aggregate when a new scan snapshot arrives", () => {
    const first = createOutlookScanDiagnostic(progress("scan-1", 100));
    const second = createOutlookScanDiagnostic({
      ...progress("scan-2", 250),
      graphPages: 9,
      graphRequests: 10,
      graphMainMessagePageSize: 50,
      graphMainMessagePages: 5,
      graphMainMessagePageFallbacks: 1
    });

    expect(first).toMatchObject({ snapshotId: "scan-1", messagesScanned: 100 });
    expect(second).toMatchObject({
      snapshotId: "scan-2",
      messagesScanned: 250,
      graphPages: 9,
      graphRequests: 10,
      mainMessagePageSize: 50,
      mainMessagePages: 5,
      mainMessagePageFallbacks: 1
    });
    expect(second.snapshotId).not.toBe(first.snapshotId);
  });

  it("carries sanitized other-4xx diagnostics from transient scan progress", () => {
    const snapshot = createOutlookScanDiagnostic({
      ...progress("scan-400", 0),
      status: "failed",
      graphOther4xxFailures: 1,
      graphLastOther4xxStatus: 400,
      graphLastOther4xxCategory: "bad_request",
      graphLastOther4xxOperation: "main_message_scan",
      graphLastNonHttpFailureOperation: "main_message_scan",
      graphLastNonHttpFailureCategory: "invalid_shape"
    });

    expect(snapshot).toMatchObject({
      result: "FAILED",
      providerFailures: {
        other4xx: 1,
        lastOther4xxStatus: 400,
        lastOther4xxCategory: "bad_request",
        lastOther4xxOperation: "main_message_scan",
        lastNonHttpFailureOperation: "main_message_scan",
        lastNonHttpFailureCategory: "invalid_shape"
      }
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/response body|request url|token|message id/i);
  });

  it("shows Copied briefly, resets, and ignores stale completion from a replaced snapshot", () => {
    let state: CopyFeedbackState = { snapshotKey: "scan-1", status: "idle" };
    state = reduceCopyFeedback(state, { type: "copy_succeeded", snapshotKey: "scan-1" });
    expect(copyFeedbackLabel(state, "scan-1", "Copy Outlook scan summary")).toBe("Copied");
    expect(COPY_FEEDBACK_DURATION_MS).toBe(1600);

    state = reduceCopyFeedback(state, { type: "snapshot_changed", snapshotKey: "scan-2" });
    expect(copyFeedbackLabel(state, "scan-2", "Copy Outlook scan summary")).toBe(
      "Copy Outlook scan summary"
    );

    state = reduceCopyFeedback(state, { type: "copy_succeeded", snapshotKey: "scan-1" });
    expect(state).toEqual({ snapshotKey: "scan-2", status: "idle" });

    state = reduceCopyFeedback(state, { type: "copy_succeeded", snapshotKey: "scan-2" });
    state = reduceCopyFeedback(state, { type: "reset", snapshotKey: "scan-2" });
    expect(copyFeedbackLabel(state, "scan-2", "Copy Outlook scan summary")).toBe(
      "Copy Outlook scan summary"
    );
  });
});

function outlookReport(): InboxReport {
  const aggregator = new StreamingReportAggregator({
    now: new Date("2026-09-01T00:00:00Z"),
    includeDiagnostics: true
  });
  aggregator.processBatch([
    ...Array.from({ length: 3 }, (_, index) => ({
      providerMessageId: `sensitive-message-id-${index}`,
      provider: "microsoft" as const,
      senderAddress: "private-sender@example.test",
      receivedAt: new Date("2020-01-01T00:00:00Z"),
      isRead: false,
      listId: "raw-private-header",
      hasListUnsubscribe: true,
      conversationId: "sensitive-conversation-id"
    })),
    {
      providerMessageId: "sensitive-message-id-protected",
      provider: "microsoft" as const,
      senderAddress: "private-sender@example.test",
      receivedAt: new Date("2026-08-31T00:00:00Z"),
      isRead: true,
      isImportant: true,
      isDeleted: true,
      isExcludedMailboxLocation: true,
      subjectProtection: "security_account" as const
    }
  ]);
  const report = aggregator.snapshot("microsoft", false);
  const signals = report.classifierDiagnostics!.messageSignals;
  signals.recentMessages = 7;
  signals.importantMessages = 6;
  signals.sentMessages = 5;
  signals.draftMessages = 4;
  signals.deletedItemsMessages = 3;
  signals.transactionalSubjectMessages = 2;
  signals.securityAccountSubjectMessages = 1;
  return report;
}

function diagnostic(): OutlookScanDiagnostic {
  return {
    snapshotId: "scan-current",
    transport: "graph",
    result: "SUCCESS",
    messagesScanned: 10_000,
    graphPages: 42,
    graphRequests: 45,
    scanMode: "full",
    foldersScanned: 6,
    maxConcurrentGraphRequests: 2,
    metadataRequests: 22,
    headerEnrichmentRequests: 0,
    messagesEnriched: 0,
    mainMessagePageSize: 100,
    mainMessagePageSizes: [100],
    mainMessagePages: 40,
    mainMessagePageFallbacks: 0,
    throttleWaitMs: 250,
    peakScanMemoryMb: 3.5,
    imapFolders: 0,
    imapMetadataBatches: 0,
    imapCommands: 0,
    imapRetries: 0,
    imapErrors: 0,
    imapPeakScanMemoryMb: 0,
    durationMs: 12_345,
    messagesPerSecond: 810.04,
    evidenceAvailability: {
      conversationIdentity: true,
      importance: true,
      categories: false,
      listId: true,
      listUnsubscribe: true,
      autoSubmitted: true,
      precedence: true
    },
    providerFailures: {
      unauthorized401: 1,
      forbidden403: 2,
      throttled429: 3,
      server5xx: 4,
      other4xx: 6,
      lastOther4xxStatus: 400,
      lastOther4xxCategory: "bad_request",
      lastOther4xxOperation: "main_message_scan",
      lastNonHttpFailureOperation: "main_message_scan",
      lastNonHttpFailureCategory: "invalid_json",
      retries: 5
    }
  };
}

function progress(scanId: string, processed: number) {
  return {
    scanId,
    status: "completed" as const,
    processed,
    graphPages: 2,
    graphRequests: 3,
    graphMainMessagePageSize: 100,
    graphMainMessagePages: 1,
    graphMainMessagePageFallbacks: 0,
    durationMs: 1000,
    messagesPerSecond: 100,
    graphEvidenceAvailability: diagnostic().evidenceAvailability
  };
}
