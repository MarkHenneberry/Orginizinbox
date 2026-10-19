import "server-only";

type Route = "cleanup_availability" | "cleanup_status" | "cleanup_action" | "gmail_scan_status" | "outlook_scan_status";

// Route-call telemetry, not an exact SQL-operation counter. Never attach requests or exceptions.
export async function observeDatabaseRoute(route: Route, run: () => Promise<Response>) {
  const started = performance.now();
  let status = 503;
  try {
    const response = await run();
    status = response.status;
    return response;
  } finally {
    if (process.env.NODE_ENV === "production") console.info("Organizinbox database activity", {
      route, event: "request", status, durationMs: Math.round(performance.now() - started)
    });
  }
}
