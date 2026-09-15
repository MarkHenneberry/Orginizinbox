export function pollingInterval(elapsedMs: number) {
  return elapsedMs < 10_000 ? 1_000 : elapsedMs < 60_000 ? 2_000 : 3_000;
}

// A response completes before scheduling another request. Returning false is terminal.
export function startAdaptivePolling(poll: (signal: AbortSignal) => Promise<boolean | void>, onError: () => void = () => {}, intervalMs?: number) {
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let wakeRequested = false;
  let stopped = false;

  function stop() {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    if (typeof window !== "undefined") window.removeEventListener("focus", wake);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
  }
  async function run() {
    if (stopped || inFlight) return;
    inFlight = true;
    wakeRequested = false;
    try {
      if (await poll(controller.signal) === false) stop();
    } catch { if (!stopped) onError(); }
    finally {
      inFlight = false;
      if (!stopped) timer = setTimeout(() => void run(), wakeRequested ? 0 : intervalMs ?? pollingInterval(Date.now() - started));
    }
  }
  function wake() {
    if (stopped || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    if (inFlight) { wakeRequested = true; return; }
    clearTimeout(timer);
    void run();
  }
  if (typeof window !== "undefined") window.addEventListener("focus", wake);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
  void run();
  return Object.assign(stop, { refresh: wake });
}
