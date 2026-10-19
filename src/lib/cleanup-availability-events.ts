export const cleanupAvailabilityChanged = "organizinbox:cleanup-availability-changed";

export function notifyCleanupAvailabilityChanged() {
  if (typeof window !== "undefined") window.dispatchEvent?.(new Event(cleanupAvailabilityChanged));
}

// The initial snapshot is server-rendered. Only real activity refreshes it afterward.
export function watchCleanupAvailability(refresh: (signal: AbortSignal) => Promise<void>, onError: () => void) {
  const controller = new AbortController();
  let lastRefresh = Date.now();
  let inFlight = false;
  let changed = false;
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  async function run(force = false) {
    if (controller.signal.aborted) return;
    if (force) changed = true;
    if (!visible() || inFlight || (!changed && Date.now() - lastRefresh < 5_000)) return;
    inFlight = true;
    changed = false;
    lastRefresh = Date.now();
    try { await refresh(controller.signal); }
    catch { if (!controller.signal.aborted) onError(); }
    finally {
      inFlight = false;
      if (changed && visible() && !controller.signal.aborted) void run(true);
    }
  }
  const focus = () => { void run(); };
  const change = () => { void run(true); };
  window.addEventListener("focus", focus);
  window.addEventListener(cleanupAvailabilityChanged, change);
  document.addEventListener("visibilitychange", focus);
  return () => {
    controller.abort();
    window.removeEventListener("focus", focus);
    window.removeEventListener(cleanupAvailabilityChanged, change);
    document.removeEventListener("visibilitychange", focus);
  };
}
