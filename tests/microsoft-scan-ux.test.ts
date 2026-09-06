import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";

const mocks = vi.hoisted(() => ({
  getActiveMicrosoftConnection: vi.fn(),
  getActiveMicrosoftImapConnection: vi.fn(),
  getAppHomeState: vi.fn(),
  getSession: vi.fn(),
  createMicrosoftScanSession: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  runtimeConfig: {
    microsoftOAuthDevEnabled: true,
    outlookImapBenchmarkDevEnabled: true
  }
}));
vi.mock("@/lib/server/app-state", () => ({ getAppHomeState: mocks.getAppHomeState }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/server/microsoft-connection", () => ({
  getActiveMicrosoftConnection: mocks.getActiveMicrosoftConnection,
  getActiveMicrosoftImapConnection: mocks.getActiveMicrosoftImapConnection
}));
vi.mock("@/lib/server/microsoft-scan", () => ({
  createMicrosoftScanSession: mocks.createMicrosoftScanSession
}));

import AppIndexPage from "../app/app/page";
import { POST } from "../app/api/app/microsoft-scan/start/route";
import { InboxReportView } from "@/components/product/InboxReportView";
import { OutlookScanClient } from "@/components/product/GmailScanClient";

describe("Outlook scan UX", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the Outlook scan action for a connected Microsoft account", async () => {
    mocks.getAppHomeState.mockResolvedValue({
      mode: "connected_no_report",
      provider: "microsoft",
      accountEmail: "person@example.test",
      reportExpired: false
    });
    const html = renderToStaticMarkup(await AppIndexPage());
    expect(html).toContain("Scan Outlook inbox");
    expect(html).toContain('href="/app/scan"');
    expect(html).toContain("Outlook cleanup is not available yet");
  });

  it("requires a Microsoft connection before starting a scan", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await POST();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Connect Microsoft before scanning Outlook." });
    expect(mocks.createMicrosoftScanSession).not.toHaveBeenCalled();
  });

  it("routes an explicit IMAP benchmark selection through the existing Outlook scan session", async () => {
    mocks.getSession.mockResolvedValue({ userId: "user-1", providerConnectionId: "connection-1" });
    mocks.getActiveMicrosoftConnection.mockResolvedValue({ connection: { id: "connection-1" } });
    mocks.getActiveMicrosoftImapConnection.mockResolvedValue({ connection: { id: "connection-1" } });
    mocks.createMicrosoftScanSession.mockResolvedValue({
      reused: false,
      progress: {
        scanId: "scan-1",
        provider: "microsoft",
        status: "running",
        limit: "full",
        batchSize: 250,
        processed: 0,
        startedAt: Date.now(),
        outlookTransport: "imap",
        duplicateStartCount: 0,
        errors: [],
        notes: []
      }
    });

    const response = await POST(new NextRequest("http://localhost:3000/api/app/microsoft-scan/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transport: "imap" })
    }));

    expect(response.status).toBe(200);
    expect(mocks.getActiveMicrosoftImapConnection).toHaveBeenCalledWith("user-1", "connection-1");
    expect(mocks.createMicrosoftScanSession).toHaveBeenCalledWith({
      userId: "user-1",
      providerConnectionId: "connection-1",
      transport: "imap"
    });
  });

  it("shows the development Graph/IMAP switch and separate IMAP consent action", () => {
    const available = renderToStaticMarkup(React.createElement(OutlookScanClient, {
      initialProgress: null,
      imapAvailable: true,
      imapBenchmarkEnabled: true
    }));
    const consentRequired = renderToStaticMarkup(React.createElement(OutlookScanClient, {
      initialProgress: null,
      imapAvailable: false,
      imapBenchmarkEnabled: true
    }));

    expect(available).toContain("Outlook scan transport");
    expect(available).toContain("IMAP benchmark");
    expect(available).not.toContain("Approve Outlook IMAP access");
    expect(consentRequired).toContain('action="/api/oauth/microsoft/imap/start"');
    expect(consentRequired).toContain("Approve Outlook IMAP access");
  });

  it("renders an Outlook report without any cleanup entry point", () => {
    const aggregator = new StreamingReportAggregator({ now: new Date("2026-08-31T00:00:00Z") });
    aggregator.processBatch(Array.from({ length: 3 }, (_, index) => ({
      providerMessageId: `message-${index}`,
      provider: "microsoft" as const,
      senderAddress: "newsletter@example.test",
      senderDisplayName: "Newsletter",
      senderDomain: "example.test",
      receivedAt: new Date("2020-01-01T00:00:00Z"),
      isRead: false,
      hasListUnsubscribe: true,
      listId: "newsletter.example.test",
      precedence: "bulk"
    })));
    const report = aggregator.snapshot("microsoft", false);
    expect(report.totals.cleanupCandidates).toBe(3);

    const html = renderToStaticMarkup(React.createElement(InboxReportView, {
      report,
      reportStale: false,
      source: "microsoft-live",
      view: "senders",
      backHref: "/app"
    }));
    expect(html).toContain("Outlook");
    expect(html).toContain("This Inbox Report is read-only.");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain(">Storage</button>");
    expect(html).not.toContain('href="/app/cleanup"');

    const overviewHtml = renderToStaticMarkup(React.createElement(InboxReportView, {
      report,
      reportStale: false,
      source: "microsoft-live",
      view: "overview",
      backHref: "/app"
    }));
    expect(overviewHtml).toContain("Potential recovery");
    expect(overviewHtml).toContain("Unavailable");
    expect(overviewHtml).not.toContain(">0 B<");

    const categoriesHtml = renderToStaticMarkup(React.createElement(InboxReportView, {
      report,
      reportStale: false,
      source: "microsoft-live",
      view: "categories",
      backHref: "/app"
    }));
    expect(categoriesHtml).toContain("Estimated size");
    expect(categoriesHtml).toContain("Unavailable");
    expect(categoriesHtml).not.toContain(">0 B<");
  });
});
