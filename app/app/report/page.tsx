import { InboxReportView } from "@/components/product/InboxReportView";
import type { ReportView } from "@/components/product/InboxReportView";
import { getActiveReportStateOrRedirect } from "@/lib/server/report-state";

const reportViews = new Set<ReportView>(["overview", "senders", "categories", "old-mail"]);

export default async function ReportPage({ searchParams }: { searchParams?: Promise<{ view?: string }> }) {
  const params = await searchParams;
  const requestedView = params?.view;
  const view = requestedView && reportViews.has(requestedView as ReportView) ? (requestedView as ReportView) : "overview";
  const activeReport = await getActiveReportStateOrRedirect();

  return (
    <InboxReportView
      backHref={activeReport.backHref}
      report={activeReport.report}
      reportStale={activeReport.reportStale}
      scanPerformance={activeReport.scanPerformance}
      source={activeReport.source}
      view={view}
    />
  );
}
