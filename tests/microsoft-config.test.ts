import { afterEach, describe, expect, it, vi } from "vitest";

describe("Microsoft OAuth configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("requires client ID, server secret, and redirect URI when Microsoft OAuth starts", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "");
    vi.stubEnv("MICROSOFT_REDIRECT_URI", "");
    const { requireMicrosoftOAuthConfig } = await import("@/lib/config");
    expect(() => requireMicrosoftOAuthConfig()).toThrow(/MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REDIRECT_URI/);
  });

  it("accepts complete server-side configuration", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "client-id");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "server-secret");
    vi.stubEnv("MICROSOFT_REDIRECT_URI", "http://localhost:3000/api/oauth/microsoft/callback");
    vi.stubEnv("MICROSOFT_TENANT_ID", "common");
    const { requireMicrosoftOAuthConfig } = await import("@/lib/config");
    expect(() => requireMicrosoftOAuthConfig()).not.toThrow();
  });

  it("rejects an authority value that could escape the Microsoft endpoint path", async () => {
    vi.stubEnv("MICROSOFT_TENANT_ID", "common/../consumers");
    await expect(import("@/lib/config")).rejects.toThrow(/MICROSOFT_TENANT_ID/);
  });

  it("keeps Outlook cleanup behind a separate default-off gate", async () => {
    vi.stubEnv("OUTLOOK_CLEANUP_DEV_ENABLED", "false");
    const { runtimeConfig } = await import("@/lib/config");
    expect(runtimeConfig.outlookCleanupDevEnabled).toBe(false);
  });
});
