"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { subscribeToUndoDeadline } from "@/lib/undo-presentation";
import type { PermanentDeleteView } from "@/lib/domain/permanent-delete";
import { UndoAction } from "@/components/product/UndoAction";

export function PostCleanupActions({ jobId, provider, moved, development, available, expiresAt, recovery, busy, onUndo }: {
  jobId: string; provider: "gmail" | "microsoft"; moved: number; development: boolean;
  available: boolean; expiresAt: number; recovery?: boolean; busy: boolean; onUndo: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{ deletion: PermanentDeleteView; canDelete: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const endpoint = `/api/app/cleanup/${provider}/permanent-delete`;
  const subscribe = useCallback((change: () => void) => subscribeToUndoDeadline(expiresAt, change), [expiresAt]);
  const expired = useCallback(() => expiresAt <= Date.now(), [expiresAt]);
  const isExpired = useSyncExternalStore(subscribe, expired, expired);
  useEffect(() => {
    if (development || moved === 0) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, action: "status" }), signal: controller.signal });
        if (!response.ok) throw new Error();
        const data = await response.json() as { deletion: PermanentDeleteView; canDelete: boolean };
        if (controller.signal.aborted) return;
        setSnapshot(data);
        if (data.deletion.status === "running") timer = setTimeout(poll, 2000);
      } catch { if (!controller.signal.aborted) setError("Deletion status is unavailable. Check again before continuing."); }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [development, moved, jobId, endpoint, refresh, busy, available]);
  const deletion = snapshot?.deletion;
  const running = deletion?.status === "running";
  async function remove() {
    if (!acknowledged || sending) return;
    setSending(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, action: "delete", confirmed: true, acknowledged: true }) });
      if (!response.ok) throw new Error();
      setSnapshot(await response.json()); setConfirming(false); setAcknowledged(false);
    } catch { setError("Deletion could not continue. Check status before trying again."); }
    finally { setSending(false); setRefresh(value => value + 1); }
  }
  const remaining = deletion?.undoRemaining;
  return <div className="grid gap-3" aria-live="polite">
    {!development ? <p className="m-0 text-sm">{moved.toLocaleString()} credits used. Undo restores the email but does not refund the credit.</p> : null}
    <UndoAction available={remaining === undefined ? available : remaining > 0} expiresAt={expiresAt} recovery={recovery || remaining !== undefined}
      busy={busy || sending || Boolean(running) || (!development && moved > 0 && !snapshot)} onUndo={onUndo} />
    {!development && deletion ? <>
      {deletion.status === "running" ? <p className="m-0">Checking and permanently deleting confirmed messages...</p> : null}
      {deletion.status === "complete" || deletion.status === "uncertain" ? <div className="text-sm">
        <p className="m-0">{deletion.verifiedDeleted.toLocaleString()} permanently deleted</p>
        <p className="m-0">{deletion.uncertain.toLocaleString()} could not be confirmed; {deletion.excluded.toLocaleString()} left alone</p>
        <p className="muted m-0">Permanent deletion has no Organizinbox Undo. No additional credits were used.</p>
      </div> : null}
      {snapshot?.canDelete && !isExpired && (deletion.status === "available" || running) ? <>
        {!confirming ? <button type="button" className="btn btn-secondary focus-ring w-full text-red-800" disabled={busy || sending}
          onClick={() => { setAcknowledged(false); setConfirming(true); }}>{running ? "Resume deletion" : "Permanently delete"}</button>
          : <PermanentDeleteConfirmation provider={provider} requested={deletion.requested} acknowledged={acknowledged}
              busy={busy} sending={sending} onAcknowledge={setAcknowledged} onCancel={() => setConfirming(false)} onConfirm={() => void remove()} />}
      </> : null}
    </> : null}
    {error ? <div role="alert"><p className="text-sm">{error}</p><button type="button" className="btn btn-secondary" onClick={() => { setError(""); setRefresh(v => v + 1); }}>Check status</button></div> : null}
  </div>;
}

export function PermanentDeleteConfirmation({ provider, requested, acknowledged, busy, sending, onAcknowledge, onCancel, onConfirm }: {
  provider: "gmail" | "microsoft"; requested: number; acknowledged: boolean; busy: boolean; sending: boolean;
  onAcknowledge: (value: boolean) => void; onCancel: () => void; onConfirm: () => void;
}) {
  return <div className="grid gap-3 border-t border-red-200 pt-4">
            <h3 className="m-0 text-base font-bold">Permanently delete these messages?</h3>
            <p className="m-0 text-sm">These emails have already been moved to {provider === "gmail" ? "Trash" : "Deleted Items"}. Permanent deletion cannot be undone by Organizinbox.</p>
            {provider === "microsoft" ? <p className="muted m-0 text-sm">Messages are permanently removed from normal Outlook access. Microsoft retention or hold rules may retain internal copies.</p> : null}
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={acknowledged} onChange={event => onAcknowledge(event.target.checked)} />
              I understand these emails cannot be restored with Organizinbox Undo.</label>
            <button type="button" className="btn btn-secondary focus-ring w-full" disabled={sending} onClick={onCancel}>Cancel</button>
            <button type="button" className="btn focus-ring w-full bg-red-800 text-white" disabled={!acknowledged || busy || sending} onClick={onConfirm}>
              {sending ? "Submitting..." : `Permanently delete up to ${requested.toLocaleString()} emails`}</button>
          </div>;
}
