import { isValidElement, type ReactNode, type ComponentProps } from "react";
import { vi } from "vitest";
import { GmailCleanupClient } from "@/components/product/GmailCleanupClient";

const cleanupPageConfig = vi.hoisted(() => ({
  gmailBulkUndoProofEnabled: false, gmailBulkUndoHistoryShadowEnabled: false,
  gmailCleanupEnabled: true, gmailCleanupMaxMessages: 100, gmailScalableCleanupDevEnabled: true
}));
export { cleanupPageConfig };
vi.mock("@/lib/config", () => ({ runtimeConfig: cleanupPageConfig }));
vi.mock("@/lib/server/report-state", () => ({ getActiveReportStateOrRedirect: async () => ({
  source: "gmail-live", report: { senders: [], fixtureMode: false }, reportStale: false
}) }));
vi.mock("@/lib/server/gmail-cleanup", () => ({ publicCleanupGroupsFromReport: () => [],
  availableCleanupCounts: () => [5, 10, 25, 50, 100], gmailCleanupHardMaximum: 100 }));
vi.mock("@/lib/server/gmail-scalable-cleanup-runner", () => ({ getCurrentGmailScalableCleanup: async () => undefined }));
vi.mock("@/lib/server/outlook-cleanup", () => ({ getCurrentOutlookCleanup: async () => undefined }));
vi.mock("@/lib/server/production-cleanup-ui", () => ({ getProductionCleanupUiState: async () => ({
  access: "available", provider: "gmail", userId: "test-owner", hasJob: false
}) }));
vi.mock("@/lib/server/live-scan-store", () => ({ getLiveScan: async () => ({
  progress: { status: "completed" }, report: { senders: [] }, reportStale: false
}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), redirect: vi.fn() }));

export async function cleanupPagePresentation() {
  const { default: Page } = await import("../../app/app/cleanup/page");
  function find(node: ReactNode): ComponentProps<typeof GmailCleanupClient> | undefined {
    if (Array.isArray(node)) {
      for (const child of node) { const result = find(child); if (result) return result; }
    } else if (isValidElement<{ children?: ReactNode }>(node)) {
      if (node.type === GmailCleanupClient) return node.props as ComponentProps<typeof GmailCleanupClient>;
      return find(node.props.children);
    }
  }
  const props = find(await Page());
  if (!props) throw new Error("Cleanup workspace was not rendered");
  return props;
}
