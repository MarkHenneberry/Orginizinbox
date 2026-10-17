import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { InboxReportView } from "@/components/product/InboxReportView";
import { OutlookVerificationNotice } from "@/components/product/OutlookVerificationNotice";
import { createOutlookProgressiveState, snapshotOutlookProgressive, applyOutlookEvidence } from "@/lib/domain/outlook-progressive";
import { HomeProviderActions } from "@/components/marketing/HomeProviderActions";
import { isLiveReportUsable } from "@/lib/domain/report-readiness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
it("renders stable pending counts apart from verified Suggested and removes the completed notice", () => {
  const state = createOutlookProgressiveState(Array.from({ length: 5 }, (_, i) => ({ provider: "microsoft", providerMessageId: String(i),
    senderAddress: "newsletter@example.test", senderDisplayName: "Newsletter", receivedAt: new Date("2020-01-01"), isRead: false, hasListUnsubscribe: false })), new Set(), Date.now());
  applyOutlookEvidence(state, 0, { hasListUnsubscribe: true });
  const report = snapshotOutlookProgressive(state, new Set());
  const html = renderToStaticMarkup(createElement(InboxReportView, { report, reportStale: false, source: "microsoft-live", view: "senders", backHref: "/app",
    outlookCleanupEnabled: true, outlookVerification: { candidates: 5, checked: 1, failed: 0, status: "running" } }));
  expect(html).toContain("Your report is ready"); expect(html).toContain("4 awaiting verification (Review)");
  expect(html).toContain("Only verified Suggested messages are available for cleanup");
  expect(renderToStaticMarkup(createElement(OutlookVerificationNotice, { verification: { candidates: 5, checked: 5, failed: 0, status: "complete" } }))).toBe("");
  const home = renderToStaticMarkup(createElement(HomeProviderActions, { actions: [
    { provider: "gmail", available: true, href: "/connect/google", label: "Scan Gmail inbox" },
    { provider: "microsoft", available: true, href: "/app/report", label: "View Outlook report" }
  ] }));
  if (process.env.UI_PREVIEW_DIR) {
    mkdirSync(process.env.UI_PREVIEW_DIR, { recursive: true });
    writeFileSync(join(process.env.UI_PREVIEW_DIR, "progressive-report.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="container">${home}</div>${html}</body></html>`);
  }
});
it("exposes only completed or explicitly published progressive reports, preserving ordinary Gmail readiness", () => {
  const report = snapshotOutlookProgressive(createOutlookProgressiveState([], new Set(), Date.now()), new Set());
  expect(isLiveReportUsable({ report, progress: { provider: "microsoft", status: "running" } })).toBe(false);
  expect(isLiveReportUsable({ report, progress: { provider: "microsoft", status: "running", reportUsableMs: 0 } })).toBe(true);
  expect(isLiveReportUsable({ report, progress: { provider: "gmail", status: "running", reportUsableMs: 0 } })).toBe(false);
  expect(isLiveReportUsable({ report, progress: { provider: "gmail", status: "completed" } })).toBe(true);
});
