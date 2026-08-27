import { ContextBackAction } from "@/components/product/ContextBackAction";
import type { OptionalReportState } from "@/lib/server/report-state";

export function BackToReportAction({ activeReport }: { activeReport: OptionalReportState }) {
  return (
    <ContextBackAction
      className="mb-5"
      href={activeReport ? "/app/report" : "/app"}
      label={activeReport ? "Back to Inbox Report" : "Back to Organizinbox"}
    />
  );
}
