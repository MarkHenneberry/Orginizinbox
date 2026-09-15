export function undoPresentation(input: { available: boolean; expiresAt: number; recovery?: boolean; completed?: boolean }, now: number) {
  if (input.completed) return { state: "complete", label: "Undo complete" } as const;
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0) return { state: "unavailable", label: "Undo unavailable" } as const;
  if (input.expiresAt <= now) return { state: "expired", label: "Undo expired" } as const;
  if (!input.available) return { state: "unavailable", label: "Undo unavailable" } as const;
  return { state: "available", label: input.recovery ? "Recovery Undo" : "Undo" } as const;
}

export function subscribeToUndoDeadline(expiresAt: number, onChange: () => void) {
  // Terminal jobs no longer poll. Wake the UI at the existing deadline, not a new TTL.
  const delay = Math.min(Math.max(expiresAt - Date.now(), 0) + 1, 2_147_483_647);
  const timer = Number.isFinite(delay) ? setTimeout(onChange, delay) : undefined;
  if (typeof window !== "undefined") window.addEventListener("focus", onChange);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onChange);
  return () => {
    clearTimeout(timer);
    if (typeof window !== "undefined") window.removeEventListener("focus", onChange);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onChange);
  };
}
