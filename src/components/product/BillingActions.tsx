"use client";
import { useRef, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { creditPacks, isCreditPack, type CreditPack } from "@/lib/billing/packs";

export function BillingActions({ canBuy, canRefresh, gmail = false, microsoft = false }: {
  canBuy: boolean; canRefresh: boolean; gmail?: boolean; microsoft?: boolean;
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmLink, setConfirmLink] = useState(false);
  async function open(action: "checkout" | "reconcile" | "link-inbox", value?: CreditPack | "gmail" | "microsoft") {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setNotice("");
    try {
      const response = await fetch(action === "checkout" ? "/api/checkout" : `/api/billing/${action}`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(action === "checkout" ? { pack: value } : action === "link-inbox" ? { provider: value, confirm: confirmLink } : {})
      });
      const result = await response.json() as { url?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Your account could not be updated.");
      if (action === "reconcile") { setNotice("Payment status checked. Verified purchases are added to your balance."); router.refresh(); }
      else {
        if (!result.url) throw new Error("Please try again from Account.");
        window.location.assign(result.url);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Please try again shortly."); }
    finally { busy.current = false; setPending(false); }
  }
  function purchase(event: MouseEvent<HTMLButtonElement>) {
    const pack = event.currentTarget.value;
    if (isCreditPack(pack)) void open("checkout", pack);
  }
  return <div aria-busy={pending} className="mt-5">
    {canBuy ? <div className="credit-packs">{Object.entries(creditPacks).map(([key, pack]) =>
      <div key={key} className="credit-pack" data-recommended={pack.credits === 50000}>
      <p className="pack-label">{pack.credits === 50000 ? "Recommended" : "One-time purchase"}</p>
      <h3>{pack.credits.toLocaleString("en-US")} credits</h3>
      <p className="pack-price">${pack.amountCents / 100} <small>USD, once</small></p>
      <button value={key} className={`btn ${pack.credits === 50000 ? "btn-primary" : "btn-secondary"} focus-ring`} disabled={pending} type="button" onClick={purchase}>
        {pack.credits.toLocaleString("en-US")} credits / ${pack.amountCents / 100} USD
      </button></div>)}</div> : null}
    <div className="mt-4 flex flex-wrap gap-3">
      {canRefresh ? <button className="btn btn-secondary focus-ring" type="button" disabled={pending} onClick={() => open("reconcile")}>Check payment status</button> : null}
    </div>
    {gmail || microsoft ? <div className="mt-6 border-t border-[var(--line)] pt-4">
      <h3 className="text-lg font-bold">Link another inbox</h3>
      <label className="flex items-start gap-2"><input className="focus-ring mt-1" type="checkbox" checked={confirmLink} onChange={(event) => setConfirmLink(event.target.checked)} />
        <span>I own the inbox I will sign in to next and want it to share this credit balance. Linking does not combine reports. Separately funded accounts cannot be combined here.</span></label>
      <div className="mt-3 flex flex-wrap gap-3">{(["gmail", "microsoft"] as const).filter((provider) => provider === "gmail" ? gmail : microsoft).map((provider) =>
        <button key={provider} className="btn btn-secondary focus-ring" type="button" disabled={pending || !confirmLink} onClick={() => open("link-inbox", provider)}>
          Link {provider === "gmail" ? "Gmail" : "Outlook"} inbox
        </button>)}</div>
    </div> : null}
    {pending ? <p role="status">Updating your account...</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert" className="text-red-700">{error}</p> : null}
  </div>;
}
