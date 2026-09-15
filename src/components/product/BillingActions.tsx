"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function BillingActions({ canSubscribe, canManage, canRefresh = false }: { canSubscribe: boolean; canManage: boolean; canRefresh?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  async function open(action: "checkout" | "portal" | "reconcile") {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(action === "checkout" ? "/api/checkout" : `/api/billing/${action}`, {
        method: "POST", headers: { Accept: "application/json" }
      });
      const result = await response.json() as { url?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Billing is temporarily unavailable.");
      if (action === "reconcile") {
        setNotice("Billing status refreshed. Recent checks may be reused for up to one minute.");
        router.refresh();
        inFlight.current = false;
        setPending(false);
        return;
      }
      if (!result.url) throw new Error("Billing is temporarily unavailable.");
      window.location.assign(result.url);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Billing is temporarily unavailable.");
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <div className="mt-4 flex flex-wrap gap-3" aria-busy={pending}>
      {canSubscribe ? <button className="btn btn-primary focus-ring" disabled={pending} onClick={() => open("checkout")} type="button">{pending ? "Updating billing..." : "Upgrade"}</button> : null}
      {canManage ? <button className="btn btn-secondary focus-ring" disabled={pending} onClick={() => open("portal")} type="button">{pending ? "Updating billing..." : "Manage billing"}</button> : null}
      {canRefresh ? <button className="btn btn-secondary focus-ring" disabled={pending} onClick={() => open("reconcile")} type="button">{pending ? "Updating billing..." : "Refresh billing status"}</button> : null}
      {notice ? <p className="muted w-full text-sm" role="status">{notice}</p> : null}
      {error ? <p className="w-full text-sm text-red-700" role="alert">{error}</p> : null}
    </div>
  );
}
