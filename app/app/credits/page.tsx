import Link from "next/link";
import { BillingPanel } from "@/components/product/BillingPanel";
import { BackToReportAction } from "@/components/product/AppContextActions";
import { getOptionalActiveReportState } from "@/lib/server/report-state";

export default async function CreditsPage() {
  const activeReport = await getOptionalActiveReportState();
  return <main className="settings-page"><div className="container settings-width">
    <BackToReportAction activeReport={activeReport} />
    <header className="settings-heading"><h1>Cleanup credits</h1><p>Pay once. Clean at your pace.</p></header>
    <BillingPanel />
    <p className="muted text-sm">Credits work across your explicitly linked Gmail and Outlook inboxes. <Link className="text-link" href="/app/account#linked-inboxes">Manage linked inboxes</Link></p>
  </div></main>;
}
