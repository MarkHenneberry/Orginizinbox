"use client";

import { useCallback, useSyncExternalStore } from "react";
import { subscribeToUndoDeadline, undoPresentation } from "@/lib/undo-presentation";

export function UndoAction({ available, expiresAt, recovery = false, completed = false, busy = false, onUndo }: {
  available: boolean;
  expiresAt: number;
  recovery?: boolean;
  completed?: boolean;
  busy?: boolean;
  onUndo: () => void;
}) {
  const subscribe = useCallback((change: () => void) => subscribeToUndoDeadline(expiresAt, change), [expiresAt]);
  const expired = useCallback(() => expiresAt <= Date.now(), [expiresAt]);
  const isExpired = useSyncExternalStore(subscribe, expired, expired);
  const presentation = undoPresentation({ available, expiresAt, recovery, completed }, isExpired ? expiresAt : 0);
  const deadline = Number.isFinite(expiresAt) && expiresAt > 0 ? new Date(expiresAt) : null;
  return (
    <div className="mt-3 grid gap-2 text-sm" aria-live="polite">
      {presentation.state === "available" ? (
        <>
          <p className="m-0 font-bold">
            {presentation.label} until{" "}
            <time dateTime={deadline!.toISOString()}>{deadline!.toLocaleString("en-US", {
              month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
              timeZone: "UTC", timeZoneName: "short"
            })}</time>
          </p>
          <p className="muted m-0">Undo needs Organizinbox&apos;s temporary restoration state. Disconnecting removes it; reconnecting will not bring it back.</p>
          {recovery ? <p className="muted m-0">Recovery Undo restores only messages confirmed moved. Uncertain messages are not included.</p> : null}
          <button className="btn btn-secondary focus-ring w-full" disabled={busy} onClick={onUndo} type="button">{presentation.label}</button>
        </>
      ) : (
        <>
          <p className="m-0 font-bold">{presentation.label}</p>
          {presentation.state === "expired" ? <p className="muted m-0">The temporary restoration window has ended. Check Trash or Deleted Items in your email account; provider recovery rules still apply.</p> : null}
          {presentation.state === "unavailable" ? <p className="muted m-0">Organizinbox cannot offer a restore for this result. Check the result and your email account before continuing.</p> : null}
        </>
      )}
    </div>
  );
}
