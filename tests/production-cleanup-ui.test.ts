import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailCleanupClient } from "@/components/product/GmailCleanupClient";
import { InboxReportView } from "@/components/product/InboxReportView";
import { getFixtureInboxReport } from "@/lib/fixtures/inbox";
import { cleanupEndpoint, type CleanupUiAccess, type GmailCleanupUiJob, type OutlookCleanupUiJob } from "@/lib/domain/cleanup-ui";
import { gmailCleanupUiJob, outlookCleanupUiJob } from "@/lib/server/production-cleanup-response";
import type { GmailScalableJobView } from "@/lib/domain/gmail-scalable-cleanup";
import type { OutlookCleanupJobView } from "@/lib/domain/outlook-cleanup";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const now = Date.parse("2026-09-11T12:00:00Z");
const gmail: GmailCleanupUiJob = {
  id: "job", status: "complete", requestedCount: 500, safeCount: 500, excludedCount: 0,
  attemptedCount: 500, verifiedCount: 500, failedCount: 0, uncertainCount: 0, verifiedRestoredCount: 0,
  failedRestoreCount: 0, uncertainRestoreCount: 0, verifiedProcessedCount: 500, suggestedDeltas: [], groupIndices: [0],
  chunkCount: 2, chunksComplete: 2, chunks: [{ index: 0, status: "complete" }, { index: 1, status: "complete" }],
  undoAvailable: true, recoveryRestoreAvailable: false, recoveryRestoreCount: 0,
  createdAt: now, updatedAt: now, expiresAt: now + 600_000
};
const outlook: OutlookCleanupUiJob = {
  provider: "microsoft", id: "job", status: "complete", requested: 500, approved: 500, excludedBySafety: 0,
  movedVerified: 500, restoredVerified: 0, failed: 0, uncertain: 0, checked: 500, groupIndices: [0],
  undoAvailable: true, undoMode: "full", undoStatus: "available", recoverableCount: 500,
  createdAt: now, updatedAt: now, expiresAt: now + 600_000, totalBatches: 25, batchesCompleted: 25,
  undoTotalBatches: 25, undoBatchesCompleted: 0
};
function render(provider: "gmail" | "microsoft", access: CleanupUiAccess, job?: GmailCleanupUiJob | OutlookCleanupUiJob) {
  return renderToStaticMarkup(createElement(GmailCleanupClient, {
    groups: [], bulkUndoProofEnabled: false, cleanupEnabled: true, legacyCleanupMaximum: 0,
    scalableCleanupEnabled: provider === "gmail", fixtureMode: false, provider,
    countOptions: provider === "gmail" ? [250, 500] : [500], reportStale: false,
    developmentMode: false, productionAccess: access,
    initialScalableJob: job && provider === "gmail" ? job as GmailCleanupUiJob : undefined,
    initialOutlookJob: job && provider === "microsoft" ? job as OutlookCleanupUiJob : undefined
  }));
}
beforeEach(() => { vi.stubEnv("NODE_ENV", "production"); vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No external requests"); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("shared production cleanup presentation", () => {
  it.each(["gmail", "microsoft"] as const)("shows %s selection only with server-resolved access and no debug sizes", (provider) => {
    const html = render(provider, "available");
    expect(html).toContain("Check 500 messages");
    expect(html).toContain("Select sender groups");
    expect(html).not.toMatch(/value="(?:5|10|25|100)"|benchmark|development|diagnostic|proof/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["upgrade", "past_due", "inactive", "unavailable", "reconnect"] as const)("hides starts for %s and provides appropriate account action", (access) => {
    for (const provider of ["gmail", "microsoft"] as const) {
      const html = render(provider, access);
      expect(html).not.toMatch(/Check 500|Select sender groups|Move up to|402|503/);
      if (access === "upgrade") expect(html).toContain(">Buy credits</a>");
      if (access === "past_due") expect(html).toContain(">Manage billing</a>");
      if (access === "inactive") expect(html).toContain(">View credits</a>");
      if (access === "unavailable") expect(html).toContain("temporarily unavailable");
    }
  });
  it.each(["gmail", "microsoft"] as const)("retains %s completion and Undo after rollback or lost entitlement without a report", (provider) => {
    for (const access of ["unavailable", "upgrade", "past_due", "inactive"] as const) {
      const html = render(provider, access, provider === "gmail" ? gmail : outlook);
      expect(html).toContain("Cleanup complete");
      expect(html).toContain("Undo until");
      expect(html).toContain('dateTime="2026-09-11T12:10:00.000Z"');
      expect(html).toContain("Sender details are no longer available");
      expect(html).not.toMatch(/Move up to|Copy .*summary|development|Workflow|Prisma|Graph|IMAP|ledger|benchmark|post-state audit/i);
    }
  });
  it("hides already-reviewed confirmation on rollback for both providers", () => {
    for (const access of ["unavailable", "inactive"] as const) {
      expect(render("gmail", access, { ...gmail, status: "ready", undoAvailable: false })).not.toContain("Move up to");
      expect(render("microsoft", access, { ...outlook, status: "ready", undoAvailable: false })).not.toContain("Move up to");
    }
    expect(render("gmail", "available", { ...gmail, status: "ready" })).toContain("to Trash");
    expect(render("microsoft", "available", { ...outlook, status: "ready" })).toContain("to Deleted Items");
  });
  it("keeps Recovery Undo and unresolved counts visible without claiming full restoration", () => {
    const html = render("microsoft", "unavailable", { ...outlook, status: "uncertain", movedVerified: 20,
      uncertain: 5, undoMode: "recovery", recoverableCount: 20 });
    expect(html).toContain("Recovery Undo until");
    expect(html).toContain("Some messages remain unresolved");
    expect(html).not.toContain("Undo complete");
    expect(render("gmail", "unavailable", { ...gmail, status: "uncertain", recoveryRestoreAvailable: true,
      recoveryRestoreCount: 20, uncertainCount: 5 })).toContain("Recovery Undo until");
  });
  it("continues to present working states and hides expired Undo", () => {
    expect(render("microsoft", "unavailable", { ...outlook, status: "running" })).toContain("Moving to Deleted Items");
    expect(render("gmail", "unavailable", { ...gmail, status: "chunk_complete", chunksComplete: 1,
      chunks: [{ index: 0, status: "complete" }, { index: 1, status: "pending" }] })).not.toContain("Cleanup complete");
    for (const provider of ["gmail", "microsoft"] as const) {
      const html = render(provider, "unavailable", { ...(provider === "gmail" ? gmail : outlook), expiresAt: now - 1 });
      expect(html).toContain("Undo expired");
      expect(html).not.toContain("Undo until");
    }
  });
  it("projects only presentation aggregates, never diagnostic or encrypted mailbox state", () => {
    const privateFields = { payload: { messageId: "mailbox-secret", originalFolderId: "folder-secret" },
      error: "raw-provider-error", graphRequests: 123, postStateAudit: { private: true }, quotaConsumedUnits: 456 };
    const content = JSON.stringify([
      gmailCleanupUiJob({ ...gmail, ...privateFields } as unknown as GmailScalableJobView),
      outlookCleanupUiJob({ ...outlook, ...privateFields } as unknown as OutlookCleanupJobView)
    ]);
    expect(content).not.toMatch(/secret|raw-provider|graphRequests|postStateAudit|quotaConsumedUnits|payload/);
    expect(content).toContain('"expiresAt"');
  });
  it("uses production endpoints for both providers while retaining development endpoints", () => {
    for (const provider of ["gmail", "microsoft"] as const) for (const action of ["start", "confirm", "status", "undo"]) {
      expect(cleanupEndpoint(provider, action, false)).toBe(`/api/app/cleanup/${provider}/${action}`);
      expect(cleanupEndpoint(provider, action, true)).toContain("/api/dev/");
    }
    expect(cleanupEndpoint("gmail", "resolve", true, false)).toBe("/api/dev/gmail-cleanup/resolve");
  });
  it.each(["gmail-live", "microsoft-live"] as const)("gates report actions and separately links recovery for %s", (source) => {
    const report = { ...getFixtureInboxReport(), fixtureMode: false };
    const reportHtml = (access: CleanupUiAccess, stale = false) => renderToStaticMarkup(createElement(InboxReportView, {
      report, source, reportStale: stale, view: "overview", backHref: "/app", productionCleanupAccess: access, existingCleanup: true
    }));
    expect(reportHtml("available")).toContain("Review cleanup");
    for (const access of ["unavailable", "upgrade", "past_due"] as const) {
      expect(reportHtml(access)).not.toContain("Review cleanup");
      expect(reportHtml(access)).toContain("View cleanup and Undo");
      expect(reportHtml(access)).not.toMatch(/Copy .*summary|classifier summary|development|diagnostic/i);
    }
    expect(reportHtml("available", true)).not.toContain("Review cleanup");
    expect(reportHtml("available", true)).toContain("View cleanup and Undo");
  });
});
