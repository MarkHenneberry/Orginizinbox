import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/server/microsoft-connection", () => ({ getActiveMicrosoftConnection: vi.fn() }));
vi.mock("@/lib/server/outlook-header-benchmark", () => ({ runOutlookHeaderBenchmark: vi.fn() }));
vi.mock("@/lib/server/provider-request-coordinator", () => ({ createProviderRequestCoordinator: vi.fn() }));
import { getSession } from "@/lib/server/session";
import { getActiveMicrosoftConnection } from "@/lib/server/microsoft-connection";
import { runOutlookHeaderBenchmark } from "@/lib/server/outlook-header-benchmark";
import { POST } from "../app/api/diagnostics/outlook-header-benchmark/route";
const request = (token = "operator") => new Request("https://example.test/api/diagnostics/outlook-header-benchmark", {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ order: "headers_first" })
});
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("CRON_SECRET", "operator"); vi.stubEnv("OUTLOOK_HEADER_BENCHMARK_ENABLED", "true"); });
afterEach(() => vi.unstubAllEnvs());
it("fails closed unless enabled and operator-authenticated", async () => {
  vi.stubEnv("OUTLOOK_HEADER_BENCHMARK_ENABLED", "false");
  expect((await POST(request())).status).toBe(404);
  vi.stubEnv("OUTLOOK_HEADER_BENCHMARK_ENABLED", "true");
  expect((await POST(request("wrong"))).status).toBe(401);
  expect(getSession).not.toHaveBeenCalled();
});
it("also requires the owning session", async () => {
  vi.mocked(getSession).mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  expect(runOutlookHeaderBenchmark).not.toHaveBeenCalled();
});
it("scopes lookup to session owner and redacts unexpected failures", async () => {
  vi.mocked(getSession).mockResolvedValue({ userId: "owner", providerConnectionId: "connection" } as never);
  vi.mocked(getActiveMicrosoftConnection).mockRejectedValue(new Error("PRIVATE DATABASE SECRET"));
  const response = await POST(request());
  expect(getActiveMicrosoftConnection).toHaveBeenCalledWith("owner", "connection");
  expect(await response.json()).toEqual({ success: false });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
