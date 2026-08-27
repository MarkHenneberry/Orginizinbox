import { BackToReportAction } from "@/components/product/AppContextActions";
import { MarketingInfoContent } from "@/components/product/MarketingInfoContent";
import { getMarketingPage } from "@/lib/marketing-pages";
import { getOptionalActiveReportState } from "@/lib/server/report-state";

export default async function AppSecurityPage() {
  const activeReport = await getOptionalActiveReportState();
  const page = getMarketingPage("security");
  if (!page) return null;

  return (
    <>
      <div className="container pt-8">
        <BackToReportAction activeReport={activeReport} />
      </div>
      <MarketingInfoContent appContext page={page} />
    </>
  );
}
