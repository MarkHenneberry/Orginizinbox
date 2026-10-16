import Link from "next/link";
import { ProviderConnectShell } from "./ProviderConnectShell";

export function InboxLinkFailure({ provider, activationFailed = false }: { provider: "Gmail" | "Outlook"; activationFailed?: boolean }) {
  return <ProviderConnectShell eyebrow="Link another inbox" backHref="/app/account" backLabel="Return to Account"
    title={activationFailed ? `${provider} was linked, but could not be opened` : `${provider} wasn't linked`}
    description={activationFailed
      ? "Your shared credit balance is unchanged. Return to Account and reconnect the linked inbox."
      : "Your existing inbox and credits were unchanged."}>
    <p className="muted">{activationFailed ? "Your inboxes remain separate." : "Return to Account to start a new linking attempt. If your session has expired, reconnect your original inbox first."}</p>
    <Link className="btn btn-primary focus-ring" href="/app/account">Return to Account</Link>
  </ProviderConnectShell>;
}
