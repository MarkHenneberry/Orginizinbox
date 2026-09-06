import type { Metadata } from "next";
import Link from "next/link";
import { ProviderConnectShell } from "@/components/product/ProviderConnectShell";
import { getAppHomeState } from "@/lib/server/app-state";

export const metadata: Metadata = {
  title: "Connect Gmail",
  robots: {
    index: false,
    follow: false
  }
};

export default async function GoogleConnectPage() {
  const state = await getAppHomeState();
  const connectedHref = state.mode === "connected_active_report" ? "/app/report" : "/app/scan";
  const connectedLabel = state.mode === "connected_active_report" ? "Return to Inbox Report" : "Scan my inbox";
  const gmailConnected = state.mode === "connected_active_report"
    || (state.mode === "connected_no_report" && state.provider === "gmail");
  const anotherProviderConnected = state.mode === "connected_no_report" && state.provider === "microsoft";
  const reconnectGmail = state.mode === "needs_reconnect" && state.provider === "gmail";

  return (
    <ProviderConnectShell
      description="Organizinbox needs access to scan your inbox and move messages you approve to Trash."
      eyebrow="Google / Gmail"
      title="Connect Gmail"
    >
      {gmailConnected ? (
        <>
          <p className="eyebrow">Gmail connected</p>
          <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">You do not need to reconnect Gmail</h2>
          <p className="muted mt-3">Continue with your current Inbox Report or start a new scan.</p>
          <Link className="btn btn-primary focus-ring mt-6" href={connectedHref}>
            {connectedLabel}
          </Link>
        </>
      ) : anotherProviderConnected ? (
        <>
          <p className="eyebrow">Microsoft connected</p>
          <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">An inbox is already connected</h2>
          <p className="muted mt-3">Manage your current Microsoft connection before connecting another inbox.</p>
          <Link className="btn btn-primary focus-ring mt-6" href="/app/account">Account</Link>
        </>
      ) : (
        <>
          <p className="eyebrow">Google / Gmail</p>
          <h2 className="m-0 mt-2 text-2xl font-extrabold text-[var(--navy)]">
            {reconnectGmail ? "Reconnect Gmail" : "Continue securely with Google"}
          </h2>
          <p className="muted mt-3">Google will ask you to approve Gmail access. Organizinbox stores encrypted connection credentials.</p>
          <form action="/api/oauth/google/start" className="mt-6" method="get">
            <button className="btn btn-primary focus-ring" type="submit">
              {reconnectGmail ? "Reconnect Gmail" : "Connect Gmail"}
            </button>
          </form>
        </>
      )}
    </ProviderConnectShell>
  );
}
