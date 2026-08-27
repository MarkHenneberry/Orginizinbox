import "server-only";
import { redirect } from "next/navigation";
import { runtimeConfig } from "@/lib/config";
import { sanitizeReportForClient } from "@/lib/domain/report-sanitizer";
import type { ClassifierScanPerformance, InboxReport, ReportSource } from "@/lib/domain/types";
import { getFixtureInboxReport } from "@/lib/fixtures/inbox";
import { getLiveScan } from "@/lib/server/live-scan-store";
import { getSession } from "@/lib/server/session";

export type ActiveReportState = {
  report: InboxReport;
  source: ReportSource;
  scanId: string;
  backHref: string;
  reportStale: boolean;
  scanPerformance?: ClassifierScanPerformance;
};

export type OptionalReportState = Pick<ActiveReportState, "source" | "scanId" | "backHref"> | null;

export async function getActiveReportStateOrRedirect(): Promise<ActiveReportState> {
  if (runtimeConfig.fixtureMode) {
    return {
      report: getFixtureInboxReport(),
      source: "fixture",
      scanId: "fixture",
      backHref: "/app",
      reportStale: false
    };
  }

  const session = await getSession();
  if (!session?.userId) {
    redirect("/app");
  }

  const liveScan = getLiveScan(session.userId);
  if (!liveScan?.report || liveScan.progress.status !== "completed") {
    redirect("/app");
  }

  return {
    report: sanitizeReportForClient(liveScan.report),
    source: `${liveScan.progress.provider}-live`,
    scanId: liveScan.progress.scanId,
    backHref: "/app",
    reportStale: liveScan.reportStale === true,
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
        : undefined
  };
}

export async function getOptionalActiveReportState(): Promise<OptionalReportState> {
  if (runtimeConfig.fixtureMode) {
    return {
      source: "fixture",
      scanId: "fixture",
      backHref: "/app"
    };
  }

  const session = await getSession();
  if (!session?.userId) return null;

  const liveScan = getLiveScan(session.userId);
  if (!liveScan?.report || liveScan.progress.status !== "completed") return null;

  return {
    source: `${liveScan.progress.provider}-live`,
    scanId: liveScan.progress.scanId,
    backHref: "/app"
  };
}
