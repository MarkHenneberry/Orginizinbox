import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { InboxReportView } from "@/components/product/InboxReportView";
import { createOutlookBaseState, snapshotOutlookBase } from "@/lib/domain/outlook-report";
import { isLiveReportUsable } from "@/lib/domain/report-readiness";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const report = snapshotOutlookBase(createOutlookBaseState(Array.from({ length: 30 }, (_, i) => ({ provider: "microsoft", providerMessageId: `private-${i}`,
  senderAddress: "news@example.test", senderDisplayName: "Newsletter", receivedAt: new Date("2020-01-01"), isRead: false })), Date.now()), new Set());
it.each(["overview", "senders", "categories"] as const)("shows a finished Outlook %s with potential, never unverified Suggested counts or background progress", view => {
  const html = renderToStaticMarkup(createElement(InboxReportView, { report, reportStale: false, source: "microsoft-live", view, backHref: "/app", outlookCleanupEnabled: true }));
  expect(html).toContain("Potential cleanup"); expect(html).toContain("Review cleanup");
  expect(html).toContain("verifies each selected message before anything moves");
  expect(html).not.toMatch(/awaiting verification|still verifying|background verification|private-/);
  expect(html).not.toContain(">Suggested<");
});
it("keeps Gmail Suggested semantics and requires completed reports for both providers", () => {
  const gmail = { ...report, provider: "gmail" as const, totals: { ...report.totals, potentialCleanup: undefined, cleanupCandidates: 30 },
    senders: report.senders.map(sender => ({ ...sender, potentialCleanupCount: undefined, reviewRecommendation: undefined })) };
  const html = renderToStaticMarkup(createElement(InboxReportView, { report: gmail, reportStale: false, source: "gmail-live", view: "overview", backHref: "/app" }));
  expect(html).toContain(">Suggested<"); expect(html).not.toContain("Outlook cleanup recommendations");
  expect(isLiveReportUsable({ report, progress: { provider: "microsoft", status: "running", reportUsableMs: 0 } })).toBe(false);
  expect(isLiveReportUsable({ report, progress: { provider: "microsoft", status: "completed" } })).toBe(true);
  expect(isLiveReportUsable({ report: gmail, progress: { provider: "gmail", status: "completed" } })).toBe(true);
});
