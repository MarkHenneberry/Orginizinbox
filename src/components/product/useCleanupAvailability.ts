"use client";
import { useEffect, useState } from "react";
import { startAdaptivePolling } from "@/lib/adaptive-polling";
import { cleanupAccessCopy, type CleanupUiAccess } from "@/lib/domain/cleanup-ui";

export function useCleanupAvailability(initial: CleanupUiAccess, enabled: boolean, provider?: "gmail" | "microsoft", hasJob = false) {
  const snapshotKey = `${provider}:${initial}:${hasJob}`;
  const [state, setState] = useState({ snapshotKey, access: initial, hasJob });
  useEffect(() => {
    if (!enabled) return;
    return startAdaptivePolling(async (signal) => {
      const response = await fetch("/api/app/cleanup/availability", { signal, cache: "no-store" });
      if (!response.ok) throw new Error("Availability unavailable");
      const value = await response.json() as { access: CleanupUiAccess; provider?: string; hasJob: boolean };
      if (signal.aborted) return false;
      if (!Object.hasOwn(cleanupAccessCopy, value.access) || (provider && value.provider !== provider)) {
        setState({ snapshotKey, access: "unavailable", hasJob: false });
      } else setState({ snapshotKey, access: value.access, hasJob: value.hasJob === true });
    }, () => setState((current) => ({ snapshotKey, access: "unavailable",
      hasJob: current.snapshotKey === snapshotKey ? current.hasJob : hasJob })), 15_000);
  }, [enabled, provider, snapshotKey, hasJob]);
  return state.snapshotKey === snapshotKey ? state : { access: initial, hasJob };
}
