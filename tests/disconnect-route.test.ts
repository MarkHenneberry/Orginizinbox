import { beforeEach, describe, expect, it, vi } from "vitest";

const disconnectMock = vi.hoisted(() => ({
  disconnectCurrentGmailSession: vi.fn(async () => ({ disconnected: true }))
}));

vi.mock("@/lib/server/disconnect", () => disconnectMock);

describe("app disconnect route", () => {
  beforeEach(() => {
    disconnectMock.disconnectCurrentGmailSession.mockClear();
  });

  it("does not disconnect on GET", async () => {
    const { GET } = await import("../app/api/app/disconnect/route");

    const response = await GET();

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(disconnectMock.disconnectCurrentGmailSession).not.toHaveBeenCalled();
  });

  it("rejects cross-origin or missing-origin POST requests without disconnecting", async () => {
    const { POST } = await import("../app/api/app/disconnect/route");

    const missingOrigin = await POST(new Request("http://localhost:3000/api/app/disconnect", { method: "POST" }));
    const crossOrigin = await POST(
      new Request("http://localhost:3000/api/app/disconnect", {
        method: "POST",
        headers: { origin: "https://example.test" }
      })
    );

    expect(missingOrigin.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(disconnectMock.disconnectCurrentGmailSession).not.toHaveBeenCalled();
  });

  it("disconnects on same-origin POST and redirects to the public homepage", async () => {
    const { POST } = await import("../app/api/app/disconnect/route");

    const response = await POST(
      new Request("http://localhost:3000/api/app/disconnect", {
        method: "POST",
        headers: { origin: "http://localhost:3000" }
      })
    );

    expect(disconnectMock.disconnectCurrentGmailSession).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });
});
