import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), connection: vi.fn(), start: vi.fn() }));
vi.mock("@/lib/config", () => ({ runtimeConfig: { gmailAvailable: true, microsoftAvailable: true } }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/server/gmail-connection", () => ({ getActiveGmailConnection: mocks.connection }));
vi.mock("@/lib/server/microsoft-connection", () => ({ getActiveMicrosoftConnection: mocks.connection,
  getActiveMicrosoftImapConnection: mocks.connection }));
vi.mock("@/lib/server/gmail-benchmark", () => ({ createGmailScanSession: mocks.start }));
vi.mock("@/lib/server/microsoft-scan", () => ({ createMicrosoftScanSession: mocks.start }));
vi.mock("@/lib/server/live-scan-store", () => ({ serializeScanProgress: (progress: unknown) => progress }));

import { POST as gmail } from "../app/api/app/gmail-scan/start/route";
import { POST as microsoft } from "../app/api/app/microsoft-scan/start/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network prohibited"); }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.session.mockResolvedValue({ userId: "private-user", providerConnectionId: "private-connection" });
  mocks.connection.mockResolvedValue({ connection: { id: "private-connection" } });
  mocks.start.mockResolvedValue({ progress: { status: "running" }, reused: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each([{ provider: "gmail", handler: gmail }, { provider: "microsoft", handler: microsoft }])(
  "$provider scan launch boundary", ({ provider, handler }) => {
    it("returns a retryable scheduling failure without raw exceptions or unnecessary reconnect", async () => {
      mocks.start.mockRejectedValueOnce(new Error("secret-token private-message-id https://private.test/response"));
      const response = await handler();
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "SCAN_START_UNAVAILABLE",
        error: "The scan could not be started. Try again shortly." });
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ component: "scan", event: "scan_start_failed", provider }));
      expect(await (await handler()).json()).toMatchObject({ reused: true });
      expect(mocks.start.mock.calls[0]).toEqual(mocks.start.mock.calls[1]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("sanitizes connection/session failures without accepting scan work", async () => {
      mocks.connection.mockRejectedValueOnce(new Error("database URL token folder-id"));
      const response = await handler();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "CONNECTION_UNAVAILABLE" });
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ component: "scan", event: "scan_connection_failed", provider }));
      expect(mocks.start).not.toHaveBeenCalled();
    });

    it("keeps missing sessions and disconnected providers unauthorized", async () => {
      mocks.session.mockResolvedValueOnce(null);
      expect((await handler()).status).toBe(401);
      mocks.connection.mockResolvedValueOnce(null);
      expect((await handler()).status).toBe(401);
      expect(mocks.start).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    });
  }
);
