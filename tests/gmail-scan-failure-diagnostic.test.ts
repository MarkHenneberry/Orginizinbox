import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/server/live-scan-store", () => ({ getLiveScan: vi.fn() }));
import { getSession } from "@/lib/server/session";
import { getLiveScan } from "@/lib/server/live-scan-store";
import { GET } from "../app/api/diagnostics/gmail-scan-failure/route";
import { classifyGmailScanFailure } from "@/lib/server/gmail-scan-failure";

const request = (token = "operator-secret") => new Request("https://example.test/api/diagnostics/gmail-scan-failure?userId=other", {
  headers: { authorization: `Bearer ${token}` }
});
function scan(category?: string) {
  vi.mocked(getLiveScan).mockResolvedValue({
    progress: { status: "failed", gmailFailureCategory: category, errors: ["PRIVATE RAW ERROR"], mailboxPath: "PRIVATE MAILBOX" },
    report: { secret: "PRIVATE METADATA" }
  } as unknown as NonNullable<Awaited<ReturnType<typeof getLiveScan>>>);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", "operator-secret");
  vi.mocked(getSession).mockResolvedValue({ userId: "owner" } as Awaited<ReturnType<typeof getSession>>);
});
afterEach(() => vi.unstubAllEnvs());

describe("temporary Gmail scan failure diagnostic", () => {
  it("requires bearer authorization before reading session or state", async () => {
    expect((await GET(request("wrong"))).status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
    expect(getLiveScan).not.toHaveBeenCalled();
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(request())).status).toBe(503);
  });
  it("also requires a valid owning session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(getLiveScan).not.toHaveBeenCalled();
  });
  it("returns only an allowlisted category from the owner's Gmail scan", async () => {
    scan("imap_auth_failed");
    const response = await GET(request());
    expect(getLiveScan).toHaveBeenCalledWith("owner", "gmail");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ scanFound: true, failureCategory: "imap_auth_failed" });
  });
  it.each([undefined, "PRIVATE RAW ERROR"])("redacts missing or arbitrary stored classifications: %s", async (value) => {
    scan(value);
    expect(await (await GET(request())).json()).toEqual({ scanFound: true, failureCategory: "unknown" });
  });
  it("does not expose raw storage exceptions", async () => {
    vi.mocked(getLiveScan).mockRejectedValue(new Error("PRIVATE DB URL"));
    expect(await (await GET(request())).json()).toEqual({ diagnosticAvailable: false, failureCategory: "durable_state_failed" });
  });
  it("handles absent/expired state", async () => {
    vi.mocked(getLiveScan).mockResolvedValue(undefined);
    expect(await (await GET(request())).json()).toEqual({ scanFound: false, failureCategory: null });
  });
  it("classifies structured signals and catch phase without returning exception text", () => {
    expect(classifyGmailScanFailure({ authenticationFailed: true, message: "PRIVATE" }, "provider")).toBe("imap_auth_failed");
    expect(classifyGmailScanFailure({ code: "CONNECT_TIMEOUT" }, "provider")).toBe("provider_connection_failed");
    expect(classifyGmailScanFailure(new Error("PRIVATE"), "connection")).toBe("provider_connection_failed");
    expect(classifyGmailScanFailure(new Error("PRIVATE"), "durable")).toBe("durable_state_failed");
    expect(classifyGmailScanFailure(new Error("PRIVATE"), "provider")).toBe("provider_request_failed");
    expect(classifyGmailScanFailure(new DOMException("PRIVATE", "AbortError"), "provider")).toBe("cancelled");
  });
});
