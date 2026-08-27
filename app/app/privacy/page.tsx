import { BackToReportAction } from "@/components/product/AppContextActions";
import { PrivacyContent } from "@/components/product/PrivacyContent";
import { getOptionalActiveReportState } from "@/lib/server/report-state";

export default async function AppPrivacyPage() {
  const activeReport = await getOptionalActiveReportState();

  return (
    <>
      <div className="container pt-8">
        <BackToReportAction activeReport={activeReport} />
      </div>
      <PrivacyContent appContext />
    </>
  );
}
