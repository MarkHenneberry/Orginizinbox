"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { HomeProviderAction } from "@/lib/server/home-provider-actions";

export function HomeProviderActions({ actions }: { actions: HomeProviderAction[] }) {
  const busy = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function open(action: HomeProviderAction) {
    if (busy.current) return;
    busy.current = true; setPending(action.provider); setError("");
    try {
      const response = await fetch("/api/app/inbox/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: action.connectionId }) });
      const result = await response.json() as { url?: string; error?: string };
      if (!response.ok || (result.url !== "/app/report" && result.url !== "/app/scan")) throw new Error(result.error ?? "Open Account to check this inbox connection.");
      window.location.assign(result.url);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Open Account to check this inbox connection."); busy.current = false; setPending(null); }
  }
  return <div>
    <div className="mt-8 flex flex-wrap gap-3" aria-label="Choose Gmail or Outlook">
      {actions.map(action => action.connectionId ? <button className="btn btn-primary focus-ring" key={action.provider} type="button" disabled={pending !== null} onClick={() => open(action)}>{pending === action.provider ? "Opening inbox..." : action.label}</button>
        : <Link key={action.provider} className={`btn ${action.available ? "btn-primary" : "btn-secondary"} focus-ring`} href={action.href}>{action.label}</Link>)}
    </div>
    {error ? <p role="alert" className="mt-3 text-sm">{error} <Link className="text-link" href="/app/account">Account</Link></p> : null}
  </div>;
}
