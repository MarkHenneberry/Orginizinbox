"use client";
import { useRef, useState } from "react";
import type { LinkedInbox } from "@/lib/domain/linked-inboxes";
import { inboxProviderLabel } from "@/lib/domain/linked-inboxes";

export function LinkedInboxList({ inboxes, onSwitch }: { inboxes: LinkedInbox[]; onSwitch?: () => void }) {
  const busy = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reconnect, setReconnect] = useState<string | null>(null);
  async function activate(inbox: LinkedInbox) {
    if (busy.current) return;
    busy.current = true; setPending(inbox.id); setError("");
    try {
      const response = await fetch("/api/app/inbox/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: inbox.id }) });
      const result = await response.json() as { url?: string; error?: string; code?: string };
      if (!response.ok) {
        if (result.code === "needs_reconnect") setReconnect(inbox.id);
        throw new Error(result.error ?? "Your inbox could not be switched. Try again.");
      }
      if (result.url !== "/app/report" && result.url !== "/app/scan") throw new Error("Your inbox could not be switched. Try again.");
      onSwitch?.();
      // Replace the entire client tree: no report or operation state crosses inboxes.
      window.location.assign(result.url);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your inbox could not be switched. Try again.");
      busy.current = false; setPending(null);
    }
  }
  return <div className="linked-inboxes" aria-busy={pending !== null}>
    <ul className="linked-inbox-list">
      {inboxes.map(inbox => {
        const provider = inboxProviderLabel(inbox.provider);
        const needsReconnect = inbox.state === "needs_reconnect" || reconnect === inbox.id;
        return <li key={inbox.id} className="linked-inbox-row" data-active={inbox.active}>
          <div className="linked-inbox-identity"><strong>{inbox.email ?? `${provider} inbox`}</strong><span>{provider}{inbox.active ? " · Active" : ""}</span></div>
          {inbox.state === "unavailable" ? <span className="muted text-sm">Temporarily unavailable</span> : needsReconnect ? <>
            <span className="muted text-sm">Needs reconnect</span>
            <form action={inbox.provider === "gmail" ? "/api/oauth/google/start" : "/api/oauth/microsoft/start"} method="get">
              <button className="text-link focus-ring" type="submit" disabled={pending !== null}>Reconnect {provider}</button>
            </form>
          </> : !inbox.active ? <button className="text-link focus-ring" type="button" disabled={pending !== null}
            aria-label={`Switch to ${inbox.email ?? provider}`} onClick={() => activate(inbox)}>{pending === inbox.id ? "Switching..." : "Switch inbox"}</button> : null}
        </li>;
      })}
    </ul>
    {pending ? <p role="status" className="muted text-sm">Switching inbox...</p> : null}
    {error ? <p role="alert" className="linked-inbox-error">{error}</p> : null}
  </div>;
}
