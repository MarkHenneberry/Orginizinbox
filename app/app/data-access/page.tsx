import { BackToReportAction } from "@/components/product/AppContextActions";
import { DataAccessContent } from "@/components/product/DataAccessContent";
import { getOptionalActiveReportState } from "@/lib/server/report-state";

export default async function AppDataAccessPage() {
  const activeReport = await getOptionalActiveReportState();

  return (
    <>
      <div className="container pt-8">
        <BackToReportAction activeReport={activeReport} />
      </div>
      <DataAccessContent appContext />
    </>
  );
}
