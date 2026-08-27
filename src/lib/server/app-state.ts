import "server-only";
import { sanitizeReportForClient } from "@/lib/domain/report-sanitizer";
import { getFixtureInboxReport } from "@/lib/fixtures/inbox";
import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";
import { getLiveScan, hasExpiredLiveScan } from "@/lib/server/live-scan-store";
import { providerAvailability } from "@/lib/providers/availability";

export type AppHomeState =
  | {
      mode: "fixture";
      report: ReturnType<typeof getFixtureInboxReport>;
    }
  | {
      mode: "none";
    }
  | {
      mode: "needs_reconnect";
      reason: string;
    }
  | {
      mode: "connected_no_report";
      accountEmail?: string;
      reportExpired: boolean;
    }
  | {
      mode: "connected_active_report";
      accountEmail?: string;
      scanId: string;
      reportStale: boolean;
      summary: {
        messages: number;
        cleanupCandidates: number;
      };
    };

export async function getAppHomeState(): Promise<AppHomeState> {
  const connection = await getCurrentProviderConnection();
  if (connection.mode === "fixture") {
    return {
      mode: "fixture",
      report: getFixtureInboxReport()
    };
  }
  if (connection.mode === "none") {
    return { mode: "none" };
  }
  if (connection.mode === "needs_reconnect") {
    return { mode: "needs_reconnect", reason: connection.reason };
  }

  const liveScan = getLiveScan(connection.userId);
  if (liveScan?.report && liveScan.progress.status === "completed") {
    const report = sanitizeReportForClient(liveScan.report);
    return {
      mode: "connected_active_report",
      accountEmail: connection.accountEmail,
      scanId: liveScan.progress.scanId,
      reportStale: liveScan.reportStale === true,
      summary: {
        messages: report.totals.messages,
        cleanupCandidates: report.totals.cleanupCandidates
      }
    };
  }

  return {
    mode: "connected_no_report",
    accountEmail: connection.accountEmail,
    reportExpired: hasExpiredLiveScan(connection.userId)
  };
}

export type PublicCtaIntent = "generic" | "gmail" | "outlook";

export type PublicPrimaryCta = {
  href: string;
  label: string;
};

export async function getPublicPrimaryCta(intent: PublicCtaIntent = "generic"): Promise<PublicPrimaryCta> {
  const state = await getAppHomeState();
  if (state.mode === "connected_active_report") {
    return { href: "/app/report", label: "Return to Inbox Report" };
  }
  if (state.mode === "connected_no_report") {
    return { href: "/app/scan", label: "Scan my inbox" };
  }
  if (state.mode === "needs_reconnect") {
    return { href: "/connect/google", label: "Reconnect Gmail" };
  }
  if (intent === "outlook" && providerAvailability.microsoft.status === "comingSoon") {
    return { href: "/guides", label: "Explore cleanup guides" };
  }
  return { href: "/connect/google", label: "Clean my inbox" };
}
