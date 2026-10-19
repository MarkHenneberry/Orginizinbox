import { afterEach, expect, it, vi } from "vitest";
import { observeDatabaseRoute } from "@/lib/server/database-usage";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("logs only fixed route, status and aggregate timing without requests, errors or response data", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const response = Response.json({ private: "mailbox-content" }, { status: 403 });
  expect(await observeDatabaseRoute("cleanup_status", async () => response)).toBe(response);
  const error = new Error("secret database URL and token");
  await expect(observeDatabaseRoute("cleanup_action", async () => { throw error; })).rejects.toBe(error);
  expect(log.mock.calls).toEqual([
    ["Organizinbox database activity", { route: "cleanup_status", event: "request", status: 403, durationMs: expect.any(Number) }],
    ["Organizinbox database activity", { route: "cleanup_action", event: "request", status: 503, durationMs: expect.any(Number) }]
  ]);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/mailbox-content|secret|token|URL/);
});
it("does not emit server route telemetry outside production", async () => {
  vi.stubEnv("NODE_ENV", "test");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  await observeDatabaseRoute("cleanup_availability", async () => new Response());
  expect(log).not.toHaveBeenCalled();
});
