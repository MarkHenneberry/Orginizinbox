import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  removeCurrentGoogleAuthorization: vi.fn(async () => ({ disconnected: true }))
}));

vi.mock("@/lib/server/disconnect", () => ({ removeCurrentGoogleAuthorization: mocks.removeCurrentGoogleAuthorization }));

describe("Remove Google authorization route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cannot be triggered by GET or prefetch", async () => {
    const { GET } = await import("../app/api/app/remove-google-authorization/route");

    const response = await GET();

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(mocks.removeCurrentGoogleAuthorization).not.toHaveBeenCalled();
  });

  it("rejects missing-origin and cross-origin POST requests", async () => {
    const { POST } = await import("../app/api/app/remove-google-authorization/route");

    const missingOrigin = await POST(new Request("http://localhost:3000/api/app/remove-google-authorization", { method: "POST" }));
    const crossOrigin = await POST(
      new Request("http://localhost:3000/api/app/remove-google-authorization", {
        method: "POST",
        headers: { origin: "https://example.test" }
      })
    );

    expect(missingOrigin.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(mocks.removeCurrentGoogleAuthorization).not.toHaveBeenCalled();
  });

  it("removes authorization on a same-origin POST and redirects safely", async () => {
    const { POST } = await import("../app/api/app/remove-google-authorization/route");

    const response = await POST(
      new Request("http://localhost:3000/api/app/remove-google-authorization", {
        method: "POST",
        headers: { origin: "http://localhost:3000" }
      })
    );

    expect(mocks.removeCurrentGoogleAuthorization).toHaveBeenCalledOnce();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });
});
