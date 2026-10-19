import { afterEach, beforeEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/session", () => ({ getSession: auth }));
import { POST } from "../app/api/app/cleanup/verification-timing/route";

const sample = { correlationId: "11111111-1111-4111-8111-111111111111", clientTotalMs: 60000,
  startRequestMs: 2000, pollRequests: 20, pollHttpMs: 1000, pollingAndWaitMs: 56980, renderAfterReadyResponseMs: 20 };
const request = (value: object, origin = "https://example.test") => new Request("https://example.test/api/app/cleanup/verification-timing", {
  method: "POST", headers: { origin }, body: JSON.stringify(value)
});
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://example.test");
  auth.mockResolvedValue({ userId: "never-log-this", providerConnectionId: "never-log-this-either" });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("requires a same-origin authenticated request", async () => {
  expect((await POST(request(sample, "https://attacker.test"))).status).toBe(403);
  auth.mockResolvedValue(null);
  expect((await POST(request(sample))).status).toBe(401);
  expect(console.info).not.toHaveBeenCalled();
});
it("accepts only bounded aggregate values and logs no session/provider identities", async () => {
  expect((await POST(request(sample))).status).toBe(204);
  expect(console.info).toHaveBeenCalledExactlyOnceWith("Outlook verification client-ready", { clientReported: true, ...sample });
});
it.each([{ ...sample, subject: "private" }, { ...sample, clientTotalMs: -1 }, { ...sample, pollRequests: 9000 },
  { ...sample, correlationId: "private@example.test" }, { ...sample, clientTotalMs: 9e9 }])("rejects malformed, out-of-range or extra data without logging it", async value => {
  expect((await POST(request(value))).status).toBe(400);
  expect(console.info).not.toHaveBeenCalled();
});
