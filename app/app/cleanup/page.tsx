import { redirect } from "next/navigation";
import Link from "next/link";
import { CleanupAccessNotice } from "@/components/product/CleanupAccessNotice";
import { getProductionCleanupUiState } from "@/lib/server/production-cleanup-ui";
import { getLiveScan } from "@/lib/server/live-scan-store";
import { ContextBackAction } from "@/components/product/ContextBackAction";
import { GmailCleanupClient } from "@/components/product/GmailCleanupClient";
import {
  isOutlookCleanupDevelopmentEnabled,
  outlookCleanupCountOptions,
  outlookCleanupMaximum
} from "@/lib/domain/outlook-cleanup";
import { runtimeConfig } from "@/lib/config";
import { gmailScalableCleanupDevCounts } from "@/lib/domain/gmail-cleanup-request-mode";
import {
  availableCleanupCounts,
  gmailCleanupHardMaximum,
  publicCleanupGroupsFromReport
} from "@/lib/server/gmail-cleanup";
import { getActiveReportStateOrRedirect } from "@/lib/server/report-state";
import { getCurrentGmailScalableCleanup } from "@/lib/server/gmail-scalable-cleanup-runner";
import { getCurrentOutlookCleanup } from "@/lib/server/outlook-cleanup";

export default async function CleanupPage() {
  if (process.env.NODE_ENV === "production") {
    const state = await getProductionCleanupUiState(true);
    // Recovery does not depend on an unexpired report or permission to start another cleanup.
    const live = state.userId && state.provider ? await getLiveScan(state.userId, state.provider).catch(() => undefined) : undefined;
    const hasJob = Boolean(state.gmailJob || state.outlookJob);
    const report = live?.progress.status === "completed" && (!hasJob || state.jobScanId === live.progress.scanId)
      ? live.report : undefined;
    return (
      <main className="py-8"><div className="container">
        <ContextBackAction className="mb-5" href="/app" label="Back to Organizinbox" />
        <p className="eyebrow">Cleanup</p>
        <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">Review cleanup</h1>
        {hasJob || (state.access === "available" && report && !live?.reportStale) ? (
          <GmailCleanupClient
            key={`${state.provider}:${state.gmailJob?.id ?? state.outlookJob?.id ?? "selection"}`}
            bulkUndoProofEnabled={false} cleanupEnabled={true} legacyCleanupMaximum={0}
            scalableCleanupEnabled={state.provider === "gmail"} countOptions={state.provider === "gmail" ? [250, 500] : [500]}
            developmentMode={false} fixtureMode={false} productionAccess={state.access}
            groups={report ? publicCleanupGroupsFromReport(report.senders) : []}
            initialScalableJob={state.gmailJob} initialOutlookJob={state.outlookJob}
            provider={state.provider!} reportStale={!report || live?.reportStale === true}
          />
        ) : state.access !== "available" ? <CleanupAccessNotice access={state.access} /> : (
          <div className="mt-6"><p>Scan your inbox for a fresh report before choosing messages to clean.</p>
            <Link className="btn btn-primary focus-ring" href="/app/scan">Scan my inbox</Link>
          </div>
        )}
      </div></main>
    );
  }
  const activeReport = await getActiveReportStateOrRedirect();
  const outlook = activeReport.source === "microsoft-live";
  const groups = publicCleanupGroupsFromReport(activeReport.report.senders);
  const outlookCleanupEnabled = outlook && isOutlookCleanupDevelopmentEnabled({
    microsoftOAuthEnabled: runtimeConfig.microsoftOAuthDevEnabled,
    outlookCleanupEnabled: runtimeConfig.outlookCleanupDevEnabled,
    fixtureMode: runtimeConfig.fixtureMode,
    nodeEnv: process.env.NODE_ENV
  });
  if (outlook && !outlookCleanupEnabled) redirect("/app/report");
  const scalableCleanupEnabled = !outlook && runtimeConfig.gmailScalableCleanupDevEnabled;
  const countOptions = outlook
    ? [...outlookCleanupCountOptions]
    : [...availableCleanupCounts(), ...(scalableCleanupEnabled ? gmailScalableCleanupDevCounts : [])];
  const initialScalableJob = !outlook && scalableCleanupEnabled ? await getCurrentGmailScalableCleanup() : undefined;
  const initialOutlookJob = outlookCleanupEnabled ? await getCurrentOutlookCleanup() : undefined;

  return (
    <main className="py-8">
      <div className="container">
        <ContextBackAction className="mb-5" href="/app/report" label="Back to Inbox Report" />
        <p className="eyebrow">Cleanup</p>
        <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">Review cleanup</h1>
        <p className="muted max-w-3xl">
          {outlook
            ? "Select one or more eligible sender groups, check the combined Suggested messages, and move only the email you approve to Deleted Items."
            : "Select one or more eligible sender groups, check the combined Suggested messages, and move only the email you approve to Trash."}
        </p>
        <GmailCleanupClient
          bulkUndoProofEnabled={
            runtimeConfig.gmailBulkUndoProofEnabled &&
            runtimeConfig.gmailBulkUndoHistoryShadowEnabled
          }
          cleanupEnabled={outlook ? outlookCleanupEnabled : runtimeConfig.gmailCleanupEnabled}
          legacyCleanupMaximum={outlook ? outlookCleanupMaximum : Math.min(runtimeConfig.gmailCleanupMaxMessages, gmailCleanupHardMaximum)}
          scalableCleanupEnabled={scalableCleanupEnabled}
          countOptions={countOptions}
          developmentMode={true}
          fixtureMode={activeReport.report.fixtureMode}
          groups={groups}
          initialScalableJob={initialScalableJob}
          initialOutlookJob={initialOutlookJob}
          provider={outlook ? "microsoft" : "gmail"}
          reportStale={activeReport.reportStale}
        />
      </div>
    </main>
  );
}
