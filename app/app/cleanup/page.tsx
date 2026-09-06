import { redirect } from "next/navigation";
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
  const scalableCleanupEnabled = !outlook && runtimeConfig.gmailScalableCleanupDevEnabled && process.env.NODE_ENV !== "production";
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
            runtimeConfig.gmailBulkUndoHistoryShadowEnabled &&
            process.env.NODE_ENV !== "production"
          }
          cleanupEnabled={outlook ? outlookCleanupEnabled : runtimeConfig.gmailCleanupEnabled}
          legacyCleanupMaximum={outlook ? outlookCleanupMaximum : Math.min(runtimeConfig.gmailCleanupMaxMessages, gmailCleanupHardMaximum)}
          scalableCleanupEnabled={scalableCleanupEnabled}
          countOptions={countOptions}
          developmentMode={process.env.NODE_ENV !== "production"}
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
