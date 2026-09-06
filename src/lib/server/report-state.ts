import "server-only";
import { redirect } from "next/navigation";
import { runtimeConfig } from "@/lib/config";
import { sanitizeReportForClient } from "@/lib/domain/report-sanitizer";
import { isOutlookCleanupDevelopmentEnabled } from "@/lib/domain/outlook-cleanup";
import { createOutlookScanDiagnostic } from "@/lib/domain/outlook-scan-summary";
import type {
  ClassifierScanPerformance,
  InboxReport,
  OutlookScanDiagnostic,
  ReportSource
} from "@/lib/domain/types";
import type { ReportRecentCleanupAction } from "@/lib/domain/report-recent-action";
import { getFixtureInboxReport } from "@/lib/fixtures/inbox";
import { getLiveScan } from "@/lib/server/live-scan-store";
import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";
import { getSession } from "@/lib/server/session";
import { getLatestGmailScalableUndoReportContext } from "@/lib/server/gmail-scalable-terminal-report";

export type ActiveReportState = {
  report: InboxReport;
  source: ReportSource;
  scanId: string;
  backHref: string;
  reportStale: boolean;
  recentCleanupAction?: ReportRecentCleanupAction;
  scanPerformance?: ClassifierScanPerformance;
  outlookScanDiagnostic?: OutlookScanDiagnostic;
  outlookCleanupEnabled?: boolean;
};

export type OptionalReportState = Pick<ActiveReportState, "source" | "scanId" | "backHref"> | null;

export async function getActiveReportStateOrRedirect(): Promise<ActiveReportState> {
  const connection = await getCurrentProviderConnection();
  if (runtimeConfig.fixtureMode) {
    return {
      report: getFixtureInboxReport(),
      source: "fixture",
      scanId: "fixture",
      backHref: "/app",
      reportStale: false
    };
  }
  if (connection.mode !== "connected") redirect("/app");

  const session = await getSession();
  if (!session?.userId) {
    redirect("/app");
  }

  const liveScan = await getLiveScan(session.userId, connection.provider);
  if (
    !liveScan?.report ||
    liveScan.progress.status !== "completed" ||
    liveScan.progress.provider !== connection.provider
  ) {
    redirect("/app");
  }

  return {
    report: sanitizeReportForClient(liveScan.report),
    source: liveScan.progress.provider === "microsoft" ? "microsoft-live" : "gmail-live",
    scanId: liveScan.progress.scanId,
    backHref: "/app",
    reportStale: liveScan.reportStale === true,
    recentCleanupAction:
      liveScan.progress.provider === "gmail"
        ? await getLatestGmailScalableUndoReportContext({
            userId: session.userId,
            activeScanId: liveScan.progress.scanId,
            activeScanCompletedAt: liveScan.progress.completedAt
          })
        : undefined,
    scanPerformance:
      process.env.NODE_ENV !== "production"
        ? {
            conversationIndexMs: liveScan.progress.conversationIndexMs,
            metadataMs: liveScan.progress.metadataMs,
            subjectProtectionMs: liveScan.progress.subjectProtectionMs,
            protectionClassificationMs: liveScan.progress.protectionClassificationMs,
            aggregationMs: liveScan.progress.aggregationMs,
            durationMs: liveScan.progress.durationMs
          }
        : undefined,
    outlookScanDiagnostic:
      process.env.NODE_ENV !== "production" && liveScan.progress.provider === "microsoft"
        ? createOutlookScanDiagnostic(liveScan.progress)
        : undefined,
    outlookCleanupEnabled:
      isOutlookCleanupDevelopmentEnabled({
        microsoftOAuthEnabled: runtimeConfig.microsoftOAuthDevEnabled,
        outlookCleanupEnabled: runtimeConfig.outlookCleanupDevEnabled,
        fixtureMode: runtimeConfig.fixtureMode,
        nodeEnv: process.env.NODE_ENV
      }) &&
      liveScan.progress.provider === "microsoft" &&
      liveScan.reportStale !== true
  };
}

export async function getOptionalActiveReportState(): Promise<OptionalReportState> {
  const connection = await getCurrentProviderConnection();
  if (runtimeConfig.fixtureMode) {
    return {
      source: "fixture",
      scanId: "fixture",
      backHref: "/app"
    };
  }
  if (connection.mode !== "connected") return null;

  const session = await getSession();
  if (!session?.userId) return null;

  const liveScan = await getLiveScan(session.userId, connection.provider);
  if (
    !liveScan?.report ||
    liveScan.progress.status !== "completed" ||
    liveScan.progress.provider !== connection.provider
  ) return null;

  return {
    source: liveScan.progress.provider === "microsoft" ? "microsoft-live" : "gmail-live",
    scanId: liveScan.progress.scanId,
    backHref: "/app"
  };
}
