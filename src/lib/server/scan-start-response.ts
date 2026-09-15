import "server-only";

// Accept only fixed categories; never pass provider/Workflow exceptions to logs.
export function scanStartFailure(provider: "gmail" | "microsoft", phase: "connection" | "start") {
  const event = phase === "start" ? "scan_start_failed" : "scan_connection_failed";
  const safeProvider = provider === "gmail" ? "gmail" : "microsoft";
  console.warn(JSON.stringify({ component: "scan", event, provider: safeProvider }));
  return Response.json({
    error: phase === "start"
      ? "The scan could not be started. Try again shortly."
      : "Your inbox connection could not be checked. Try again shortly or reconnect from Account.",
    code: phase === "start" ? "SCAN_START_UNAVAILABLE" : "CONNECTION_UNAVAILABLE"
  }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
