import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxReportView } from "@/components/product/InboxReportView";
import { sanitizeReportForClient } from "@/lib/domain/report-sanitizer";
import {
  createSenderWorkspaceState,
  filterAndSortSenders,
  reduceSenderWorkspaceState,
  type SenderSortKey
} from "@/lib/domain/sender-view";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import type { InboxReport, NormalizedMessageMetadata } from "@/lib/domain/types";

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
    hasListUnsubscribe: true,
    ...overrides
  };
}

function report(messages: NormalizedMessageMetadata[], includeDiagnostics = false): InboxReport {
  const aggregator = new StreamingReportAggregator({ now, includeDiagnostics });
  aggregator.processBatch(messages);
  return aggregator.snapshot("gmail", false);
}

describe("complete sender collection", () => {
  it("renders every sender instead of a top-30 subset", () => {
    const inbox = report(
      Array.from({ length: 157 }, (_, index) =>
        message({
          providerMessageId: `message-${index}`,
          senderAddress: `sender-${index}@example.test`,
          senderDisplayName: `Sender ${index}`
        })
      )
    );
    const html = renderToStaticMarkup(
      React.createElement(InboxReportView, {
        report: inbox,
        reportStale: false,
        source: "gmail-live",
        view: "senders",
        backHref: "/app"
      })
    );

    expect(inbox.senders).toHaveLength(157);
    expect(html).toContain("157 of 157 sender groups");
    expect(html).toContain("Sender 156");
    expect(html).toContain("Search senders");
    expect(html).toContain("Most suggested");
    expect(html).toContain("Recommendation");
  });

  it("renders a contained desktop workspace and a normal-flow mobile stack", () => {
    const inbox = report([
      message({ providerMessageId: "fiverr", senderAddress: "announce@fiverr.example", senderDisplayName: "Fiverr" }),
      message({ providerMessageId: "runway", senderAddress: "receipts@runway.example", senderDisplayName: "Runway" })
    ]);
    const html = renderToStaticMarkup(
      React.createElement(InboxReportView, {
        report: inbox,
        reportStale: false,
        source: "gmail-live",
        view: "senders",
        backHref: "/app"
      })
    );

    expect(html).toContain('data-layout="sender-workspace"');
    expect(html).toContain('data-pane="sender-browser"');
    expect(html).toContain('data-scroll-region="sender-list"');
    expect(html).toContain('data-pane="sender-detail"');
    expect(html).toContain('data-sender-controls="sticky"');
    expect(html).toContain('data-mobile-layout="stacked"');
    expect(html).toContain('data-mobile-detail="inline"');
    expect(html).toContain("lg:h-[calc(100dvh-12rem)]");
    expect(html).toContain("lg:hidden");
  });

  it("marks the initial sender selection visibly and semantically", () => {
    const inbox = report([
      ...Array.from({ length: 3 }, (_, index) =>
        message({ providerMessageId: `alpha-${index}`, senderAddress: "alpha@example.test", senderDisplayName: "Alpha" })
      ),
      message({ providerMessageId: "beta", senderAddress: "beta@example.test", senderDisplayName: "Beta" })
    ]);
    const html = renderToStaticMarkup(
      React.createElement(InboxReportView, {
        report: inbox,
        reportStale: false,
        source: "gmail-live",
        view: "senders",
        backHref: "/app"
      })
    );

    expect(html).toContain('data-selected="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Selected");
    expect(html).toContain("Sort senders");
  });

  it("keeps the same full key set under every sort", () => {
    const inbox = report(
      Array.from({ length: 40 }, (_, index) =>
        message({
          providerMessageId: `message-${index}`,
          senderAddress: `sender-${index}@example.test`,
          senderDisplayName: `Sender ${index}`,
          isRead: index % 2 === 0,
          estimatedSize: index * 100
        })
      )
    );
    const expectedKeys = new Set(inbox.senders.map((sender) => sender.senderKey));
    const sorts: SenderSortKey[] = ["emails", "ready", "unread", "oldest", "storage", "recommendation"];

    for (const sort of sorts) {
      const sorted = filterAndSortSenders(inbox.senders, "", sort);
      expect(sorted).toHaveLength(inbox.senders.length);
      expect(new Set(sorted.map((sender) => sender.senderKey))).toEqual(expectedKeys);
    }
  });

  it("searches the full collection by display name, domain, and development identity", () => {
    const inbox = sanitizeReportForClient(
      report([
        message({ senderAddress: "announce@fiverr.example", senderDisplayName: "Fiverr", senderDomain: "announce.fiverr.com" }),
        message({ senderAddress: "receipts@runway.example", senderDisplayName: "Runway", senderDomain: "comms.runwayml.com" }),
        message({ senderAddress: "other@example.test", senderDisplayName: "Other" })
      ], true),
      true
    );

    expect(filterAndSortSenders(inbox.senders, "Fiverr", "emails").map((sender) => sender.displayName)).toEqual(["Fiverr"]);
    expect(filterAndSortSenders(inbox.senders, "comms.runwayml.com", "emails").map((sender) => sender.displayName)).toEqual(["Runway"]);
    expect(filterAndSortSenders(inbox.senders, "announce@fiverr.example", "emails").map((sender) => sender.displayName)).toEqual(["Fiverr"]);
  });
});

describe("sender workspace interaction state", () => {
  const inbox = report([
    ...Array.from({ length: 4 }, (_, index) =>
      message({
        providerMessageId: `alpha-${index}`,
        senderAddress: "alpha@example.test",
        senderDisplayName: "Alpha",
        estimatedSize: 100
      })
    ),
    ...Array.from({ length: 2 }, (_, index) =>
      message({
        providerMessageId: `fiverr-${index}`,
        senderAddress: "announce@fiverr.example",
        senderDisplayName: "Fiverr",
        estimatedSize: 5000
      })
    ),
    message({
      providerMessageId: "runway",
      senderAddress: "receipts@runway.example",
      senderDisplayName: "Runway",
      estimatedSize: 200
    })
  ]);

  it("updates selection without changing search or sort state", () => {
    let state = createSenderWorkspaceState(inbox.senders);
    state = reduceSenderWorkspaceState(inbox.senders, state, { type: "sort", sortKey: "storage" });
    state = reduceSenderWorkspaceState(inbox.senders, state, { type: "search", search: "Fiverr" });
    const fiverrKey = filterAndSortSenders(inbox.senders, "Fiverr", "storage")[0].senderKey;
    state = reduceSenderWorkspaceState(inbox.senders, state, { type: "select", senderKey: fiverrKey });

    expect(state).toEqual({ search: "Fiverr", sortKey: "storage", selectedSenderKey: fiverrKey });
  });

  it("selects the first remaining sender when filtering removes the selection", () => {
    let state = createSenderWorkspaceState(inbox.senders);
    const alphaKey = state.selectedSenderKey;
    state = reduceSenderWorkspaceState(inbox.senders, state, { type: "search", search: "Runway" });
    const runwayKey = filterAndSortSenders(inbox.senders, "Runway", "emails")[0].senderKey;

    expect(state.selectedSenderKey).toBe(runwayKey);
    expect(state.selectedSenderKey).not.toBe(alphaKey);

    state = reduceSenderWorkspaceState(inbox.senders, state, { type: "search", search: "" });
    expect(state.selectedSenderKey).toBe(runwayKey);
  });

  it("retains selection when sorting reorders the complete result", () => {
    let state = createSenderWorkspaceState(inbox.senders);
    const selectedSenderKey = state.selectedSenderKey;
    state = reduceSenderWorkspaceState(inbox.senders, state, { type: "sort", sortKey: "storage" });

    expect(state.selectedSenderKey).toBe(selectedSenderKey);
    expect(state.sortKey).toBe("storage");
    expect(filterAndSortSenders(inbox.senders, state.search, state.sortKey)).toHaveLength(inbox.senders.length);
  });

  it("uses local buttons rather than sender-selection route navigation", () => {
    const source = readFileSync("src/components/product/InboxReportView.tsx", "utf8");
    expect(source).toMatch(/type="button"/);
    expect(source).not.toMatch(/href=.*senderKey|router\.(push|replace).*sender/i);
  });
});

describe("sender detail eligibility", () => {
  it.each([
    ["high", 3, false],
    ["very_high", 30, true]
  ] as const)("keeps the %s sender cleanup action", (expectedConfidence, count, addListId) => {
    const inbox = report(
      Array.from({ length: count }, (_, index) =>
        message({
          providerMessageId: `eligible-${index}`,
          listId: addListId ? "offers.example" : undefined
        })
      )
    );
    const html = renderToStaticMarkup(
      React.createElement(InboxReportView, {
        report: inbox,
        reportStale: false,
        source: "gmail-live",
        view: "senders",
        backHref: "/app"
      })
    );

    expect(inbox.senders[0].cleanupConfidence).toBe(expectedConfidence);
    expect(html).toContain(`Review ${count} emails`);
  });

  it("keeps the cleanup action absent for a Keep sender", () => {
    const inbox = report([message({ hasListUnsubscribe: false })]);
    const html = renderToStaticMarkup(
      React.createElement(InboxReportView, {
        report: inbox,
        reportStale: false,
        source: "gmail-live",
        view: "senders",
        backHref: "/app"
      })
    );

    expect(inbox.senders[0].cleanupConfidence).toBe("keep");
    expect(html).toContain("Nothing recommended for cleanup");
    expect(html).not.toContain('href="/app/cleanup"');
  });
});

describe("same-display-name sender diagnostics", () => {
  it("keeps exact sender groups distinct and reveals which group contains the star in development", () => {
    const messages = [
      ...Array.from({ length: 3 }, (_, index) =>
        message({
          providerMessageId: `announce-${index}`,
          senderAddress: "announce@fiverr.example",
          senderDisplayName: "Fiverr",
          senderDomain: "announce.fiverr.com"
        })
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        message({
          providerMessageId: `notifications-${index}`,
          senderAddress: "notifications@fiverr.example",
          senderDisplayName: "Fiverr",
          senderDomain: "notifications.fiverr.com",
          isStarred: index === 0
        })
      )
    ];
    const inbox = sanitizeReportForClient(report(messages, true), true);
    const fiverrGroups = filterAndSortSenders(inbox.senders, "Fiverr", "emails");
    const html = renderToStaticMarkup(
      React.createElement(InboxReportView, {
        report: inbox,
        reportStale: false,
        source: "gmail-live",
        view: "senders",
        backHref: "/app"
      })
    );

    expect(fiverrGroups).toHaveLength(2);
    expect(fiverrGroups.map((sender) => sender.diagnosticSenderIdentity)).toEqual(
      expect.arrayContaining(["announce@fiverr.example", "notifications@fiverr.example"])
    );
    expect(
      fiverrGroups.find((sender) => sender.diagnosticSenderIdentity === "notifications@fiverr.example")?.diagnostics
        ?.messageSignals.starredMessages
    ).toBe(1);
    expect(html).toContain("Matching sender groups");
    expect(html).toContain("notifications@fiverr.example - Total 3 - Starred 1");
    expect(html).toContain("Classifier inspection (development)");
    expect(html).toContain("Copy sender summary");
  });

  it("strips exact sender identities in production serialization", () => {
    const inbox = sanitizeReportForClient(
      report([message({ senderAddress: "private@fiverr.example", senderDisplayName: "Fiverr" })], true),
      false
    );
    expect(JSON.stringify(inbox)).not.toContain("private@fiverr.example");
    expect(inbox.senders[0].diagnosticSenderIdentity).toBeUndefined();
  });
});
