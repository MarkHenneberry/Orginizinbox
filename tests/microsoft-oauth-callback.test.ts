import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieHarness = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const store = {
    get(name: string) {
      const value = jar.get(name);
      return value ? { value } : undefined;
    },
    set(name: string, value: string, options: { maxAge?: number }) {
      if (options.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    }
  };
  return { jar, cookies: vi.fn(async () => store) };
});

const oauth = vi.hoisted(() => {
  class MicrosoftIdentityValidationError extends Error {}
  class MicrosoftImapScopeNotGrantedError extends Error {}
  class MicrosoftRefreshTokenMissingError extends Error {}
  class MicrosoftScopeNotGrantedError extends Error {}
  class MicrosoftTokenResponseError extends Error {}
  return {
    MicrosoftIdentityValidationError,
    MicrosoftImapScopeNotGrantedError,
    MicrosoftRefreshTokenMissingError,
    MicrosoftScopeNotGrantedError,
    MicrosoftTokenResponseError,
    exchangeMicrosoftCode: vi.fn(),
    saveMicrosoftImapCredentials: vi.fn(),
    upsertMicrosoftConnection: vi.fn(),
    verifyMicrosoftImapTokenResponse: vi.fn(),
    verifyMicrosoftTokenResponse: vi.fn()
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers.js", () => ({ cookies: cookieHarness.cookies }));
vi.mock("@/lib/config", () => ({
  env: { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64") },
  runtimeConfig: { microsoftOAuthDevEnabled: true }
}));
vi.mock("@/lib/server/microsoft-oauth", () => oauth);
vi.mock("@/lib/server/db", async () => {
  const { createSessionConnectionFixture } = await import("./fixtures/session-connection");
  return { prisma: createSessionConnectionFixture().client };
});

describe("Microsoft OAuth callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieHarness.jar.clear();
    vi.stubEnv("NODE_ENV", "development");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    oauth.exchangeMicrosoftCode.mockResolvedValue({ access_token: "access", refresh_token: "refresh", id_token: "id", scope: "Mail.ReadWrite" });
    oauth.verifyMicrosoftTokenResponse.mockResolvedValue({
      access_token: "access",
      refresh_token: "refresh",
      id_token: "id",
      scope: "mail.readwrite",
      identity: { tenantId: "tenant", subject: "subject" }
    });
    oauth.verifyMicrosoftImapTokenResponse.mockResolvedValue({
      access_token: "imap-access",
      refresh_token: "imap-refresh",
      id_token: "imap-id",
      scope: "imap.accessasuser.all",
      identity: { tenantId: "tenant", subject: "subject" }
    });
    oauth.upsertMicrosoftConnection.mockResolvedValue({ user: { id: "user-1" }, connection: { id: "connection-1" } });
  });

  it("consumes provider-bound state and passes the exact PKCE verifier and nonce", async () => {
    const { createOAuthState, getSession } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/microsoft/callback/route");
    const state = await createOAuthState("/app/account", {
      provider: "microsoft",
      codeVerifier: "pkce-verifier",
      nonce: "oidc-nonce"
    });

    const response = await GET(new NextRequest(`http://localhost:3000/api/oauth/microsoft/callback?code=authorization-code&state=${state}`));

    expect(response.headers.get("location")).toBe("http://localhost:3000/app/account");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(oauth.exchangeMicrosoftCode).toHaveBeenCalledWith("authorization-code", "pkce-verifier", "graph");
    expect(oauth.verifyMicrosoftTokenResponse).toHaveBeenCalledWith(expect.any(Object), "oidc-nonce");
    await expect(getSession()).resolves.toMatchObject({ userId: "user-1", providerConnectionId: "connection-1" });
    expect(cookieHarness.jar.has("organizinbox_oauth_state")).toBe(false);
  });

  it("binds separate IMAP consent to the existing Microsoft session and connection", async () => {
    const { createOAuthState, setSessionCookie } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/microsoft/callback/route");
    await setSessionCookie({ userId: "user-1", providerConnectionId: "connection-1", createdAt: Date.now() });
    const state = await createOAuthState("/app/scan", {
      provider: "microsoft",
      codeVerifier: "imap-verifier",
      nonce: "imap-nonce",
      microsoftFlow: "imap"
    });

    const response = await GET(new NextRequest(`http://localhost:3000/api/oauth/microsoft/callback?code=imap-code&state=${state}`));

    expect(response.headers.get("location")).toBe("http://localhost:3000/app/scan");
    expect(oauth.exchangeMicrosoftCode).toHaveBeenCalledWith("imap-code", "imap-verifier", "imap");
    expect(oauth.verifyMicrosoftImapTokenResponse).toHaveBeenCalledWith(expect.any(Object), "imap-nonce");
    expect(oauth.saveMicrosoftImapCredentials).toHaveBeenCalledWith({
      userId: "user-1",
      providerConnectionId: "connection-1",
      tokens: expect.objectContaining({ access_token: "imap-access" })
    });
    expect(oauth.upsertMicrosoftConnection).not.toHaveBeenCalled();
  });

  it("rejects missing, mismatched, and cross-provider state before token exchange", async () => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/microsoft/callback/route");
    const googleState = await createOAuthState("/app", { provider: "google" });
    const mismatch = await GET(new NextRequest(`http://localhost:3000/api/oauth/microsoft/callback?code=code&state=${googleState}`));
    const missing = await GET(new NextRequest("http://localhost:3000/api/oauth/microsoft/callback?code=code"));

    expect(mismatch.headers.get("location")).toContain("reason=state_invalid");
    expect(missing.headers.get("location")).toContain("reason=state_invalid");
    expect(oauth.exchangeMicrosoftCode).not.toHaveBeenCalled();
  });

  it("consumes state on cancellation and rejects callback replay", async () => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/microsoft/callback/route");
    const state = await createOAuthState("/app", {
      provider: "microsoft",
      codeVerifier: "verifier",
      nonce: "nonce"
    });
    const denied = await GET(new NextRequest(`http://localhost:3000/api/oauth/microsoft/callback?error=access_denied&state=${state}`));
    const replay = await GET(new NextRequest(`http://localhost:3000/api/oauth/microsoft/callback?code=code&state=${state}`));
    expect(denied.headers.get("location")).toContain("reason=oauth_denied");
    expect(replay.headers.get("location")).toContain("reason=state_invalid");
  });

  it.each([
    [new oauth.MicrosoftScopeNotGrantedError(), "scope_missing"],
    [new oauth.MicrosoftRefreshTokenMissingError(), "refresh_token_missing"],
    [new oauth.MicrosoftTokenResponseError(), "token_exchange_failed"],
    [new oauth.MicrosoftIdentityValidationError(), "identity_failed"]
  ])("maps verified failures to sanitized recovery categories", async (failure, reason) => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/microsoft/callback/route");
    oauth.verifyMicrosoftTokenResponse.mockRejectedValueOnce(failure);
    const state = await createOAuthState("/app", {
      provider: "microsoft",
      codeVerifier: "verifier",
      nonce: "nonce"
    });
    const response = await GET(new NextRequest(`http://localhost:3000/api/oauth/microsoft/callback?code=code&state=${state}`));
    expect(response.headers.get("location")).toContain(`reason=${reason}`);
    expect(oauth.upsertMicrosoftConnection).not.toHaveBeenCalled();
  });

  it("logs only an allowlisted result and never logs callback secrets", async () => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/microsoft/callback/route");
    const state = await createOAuthState("/app", {
      provider: "microsoft",
      codeVerifier: "secret-verifier",
      nonce: "secret-nonce"
    });
    await GET(new NextRequest(`http://localhost:3000/api/oauth/microsoft/callback?code=secret-code&state=${state}`));
    const output = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(output).toContain('"result":"success"');
    for (const forbidden of ["secret-code", "secret-verifier", "secret-nonce", state, "access", "refresh", "user-1", "connection-1"]) {
      expect(output).not.toContain(forbidden);
    }
  });
});
