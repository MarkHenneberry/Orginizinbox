import { ContextBackAction } from "@/components/product/ContextBackAction";
import { GmailCleanupClient } from "@/components/product/GmailCleanupClient";
import { runtimeConfig } from "@/lib/config";
import { gmailScalableCleanupDevCounts } from "@/lib/domain/gmail-cleanup-request-mode";
import {
  availableCleanupCounts,
  gmailCleanupHardMaximum,
  publicCleanupGroupsFromReport
} from "@/lib/server/gmail-cleanup";
import { getActiveReportStateOrRedirect } from "@/lib/server/report-state";
import { getCurrentGmailScalableCleanup } from "@/lib/server/gmail-scalable-cleanup-runner";

export default async function CleanupPage() {
  const activeReport = await getActiveReportStateOrRedirect();
  const groups = publicCleanupGroupsFromReport(activeReport.report.senders);
  const scalableCleanupEnabled = runtimeConfig.gmailScalableCleanupDevEnabled && process.env.NODE_ENV !== "production";
  const countOptions = [
    ...availableCleanupCounts(),
    ...(scalableCleanupEnabled ? gmailScalableCleanupDevCounts : [])
  ];
  const initialScalableJob = scalableCleanupEnabled ? await getCurrentGmailScalableCleanup() : undefined;

  return (
    <main className="py-8">
      <div className="container">
        <ContextBackAction className="mb-5" href="/app/report" label="Back to Inbox Report" />
        <p className="eyebrow">Cleanup</p>
        <h1 className="m-0 mt-2 text-4xl font-extrabold text-[var(--navy)]">Review cleanup</h1>
        <p className="muted max-w-3xl">
          Select one or more eligible sender groups, check the combined Suggested messages, and move only the email you approve to Trash.
        </p>
        <GmailCleanupClient
          bulkUndoProofEnabled={
            runtimeConfig.gmailBulkUndoProofEnabled &&
            runtimeConfig.gmailBulkUndoHistoryShadowEnabled &&
            process.env.NODE_ENV !== "production"
          }
          cleanupEnabled={runtimeConfig.gmailCleanupEnabled}
          legacyCleanupMaximum={Math.min(runtimeConfig.gmailCleanupMaxMessages, gmailCleanupHardMaximum)}
          scalableCleanupEnabled={scalableCleanupEnabled}
          countOptions={countOptions}
          developmentMode={process.env.NODE_ENV !== "production"}
          fixtureMode={activeReport.report.fixtureMode}
          groups={groups}
          initialScalableJob={initialScalableJob}
          reportStale={activeReport.reportStale}
        />
      </div>
    </main>
  );
}
