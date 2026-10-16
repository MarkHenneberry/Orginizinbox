"use client";

import { useEffect, useRef } from "react";

type AccountingSnapshot = { id: string; status: string; moved: number } | null;
const terminal = new Set(["complete", "partial", "failed", "uncertain", "expired", "undo_complete"]);
function accountingKey(job: AccountingSnapshot) {
  return job && terminal.has(job.status) ? `${job.id}:${job.moved}` : null;
}

export function useCleanupCreditRefresh(job: AccountingSnapshot, enabled: boolean, refresh: () => void) {
  const key = accountingKey(job);
  // A server-provided terminal job already came with a fresh balance. Also prevents
  // a refresh/remount cycle when the route gains its newly accepted job key.
  const presented = useRef(key);
  useEffect(() => {
    if (!enabled || key === null || key === presented.current) return;
    presented.current = key;
    refresh();
  }, [enabled, key, refresh]);
}
