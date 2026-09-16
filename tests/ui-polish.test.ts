import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxReportView } from "@/components/product/InboxReportView";
import { GmailCleanupClient } from "@/components/product/GmailCleanupClient";
import { GmailScanClient, OutlookScanClient } from "@/components/product/GmailScanClient";
import { BillingActions } from "@/components/product/BillingActions";
import { getFixtureInboxReport } from "@/lib/fixtures/inbox";
import { buildCleanupSenderGroups } from "@/lib/providers/gmail/cleanup-candidates";
import type { OutlookCleanupUiJob } from "@/lib/domain/cleanup-ui";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const now = Date.parse("2026-09-16T12:00:00Z");
const report = getFixtureInboxReport();
const groups = buildCleanupSenderGroups(report.senders);
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No external requests in UI fixtures"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Optional synthetic, static pages for browser layout checks. Never include real account data.
function render(name: string, element: ReactElement) {
  const html = renderToStaticMarkup(element);
  if (process.env.UI_PREVIEW_DIR) {
    mkdirSync(process.env.UI_PREVIEW_DIR, { recursive: true });
    writeFileSync(join(process.env.UI_PREVIEW_DIR, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>UI fixture: ${name}</title><link rel="stylesheet" href="compiled.css"></head><body><div class="${name.startsWith("report-") ? "" : "container py-8"}">${html}</div></body></html>`);
  }
  return html;
}

describe("polished shared UI preserves product actions", () => {
  it.each(["overview", "senders", "categories", "old-mail"] as const)("renders the %s report with an accessible current view", (view) => {
    const html = render(`report-${view}`, createElement(InboxReportView, {
      report, source: "gmail-live", view, backHref: "/app", reportStale: false, productionCleanupAccess: "available"
    }));
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Review cleanup");
    if (view === "overview") {
      for (const bucket of ["suggested", "review", "protected"]) expect(html).toContain(`data-bucket="${bucket}"`);
      expect(html).toContain("Not included in suggested cleanup");
      expect(html).toContain("Kept out of cleanup");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains all three explicit purchase choices with only the middle pack recommended", () => {
    const html = render("credit-packs", createElement(BillingActions, { canBuy: true, canRefresh: true, gmail: true, microsoft: true }));
    expect(html.match(/data-recommended="true"/g)).toHaveLength(1);
    expect(html).toMatch(/Recommended<\/p><h3>50,000 credits/);
    for (const price of [10, 15, 20]) expect(html).toContain(`$${price}`);
    expect(html.match(/onetime|subscription automatically|Best value/i)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["gmail", "microsoft"] as const)("keeps %s progress live and scan actions disabled while working", (provider) => {
    const initialProgress = { provider, scanId: "synthetic", status: "running" as const, processed: 5000, mailboxExists: 10000, startedAt: now - 1000, errors: [] };
    const html = render(`scan-${provider}`, provider === "gmail"
      ? createElement(GmailScanClient, { initialProgress })
      : createElement(OutlookScanClient, { initialProgress, imapAvailable: false, imapBenchmarkEnabled: false }));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("disabled");
    if (provider === "gmail") expect(html).toContain('aria-valuenow="50"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["selection", "ready", "running", "complete", "uncertain"] as const)("preserves Outlook %s actions and recovery deadlines", (status) => {
    const job: OutlookCleanupUiJob = {
      provider: "microsoft", id: "synthetic", status: status === "selection" ? "ready" : status,
      requested: 500, approved: 500, excludedBySafety: 0, movedVerified: status === "uncertain" ? 480 : 500,
      restoredVerified: 0, failed: 0, uncertain: status === "uncertain" ? 20 : 0, checked: 500,
      groupIndices: [1, 2], undoAvailable: true, undoMode: status === "uncertain" ? "recovery" : "full",
      undoStatus: "available", recoverableCount: status === "uncertain" ? 480 : 500,
      createdAt: now, updatedAt: now, expiresAt: now + 600_000, totalBatches: 25, batchesCompleted: 25,
      undoTotalBatches: 25, undoBatchesCompleted: 0
    };
    const html = render(`cleanup-${status}`, createElement(GmailCleanupClient, {
      groups, provider: "microsoft", bulkUndoProofEnabled: false, cleanupEnabled: true,
      legacyCleanupMaximum: 0, scalableCleanupEnabled: false, fixtureMode: false, countOptions: [500],
      reportStale: false, developmentMode: false, productionAccess: "available",
      initialOutlookJob: status === "selection" ? undefined : job
    }));
    if (status === "selection") expect(html).toContain("Check 500 messages");
    if (status === "ready") expect(html).toContain("Move up to 500 to Deleted Items");
    if (status === "complete" || status === "uncertain") {
      expect(html).toContain('dateTime="2026-09-16T12:10:00.000Z"');
      expect(html).toContain(status === "uncertain" ? "Recovery Undo" : "Undo until");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
