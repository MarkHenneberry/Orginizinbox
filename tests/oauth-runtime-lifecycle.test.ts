import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CookieOptions = {
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  secure?: boolean;
  path?: string;
  maxAge?: number;
};

const cookieHarness = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const setCalls: Array<{ name: string; value: string; options: CookieOptions }> = [];
  const state = { failSessionSet: false };
  const store = {
    get(name: string) {
      const value = jar.get(name);
      return value ? { value } : undefined;
    },
    set(name: string, value: string, options: CookieOptions) {
      if (name === "organizinbox_session" && state.failSessionSet) throw new Error("session write failed");
      setCalls.push({ name, value, options });
      if (options.maxAge === 0) {
        jar.delete(name);
        return;
      }
      jar.set(name, value);
    }
  };

  return {
    jar,
    setCalls,
    cookies: vi.fn(async () => store),
    reset() {
      jar.clear();
      setCalls.length = 0;
      state.failSessionSet = false;
      this.cookies.mockClear();
    },
    failSessionSet() {
      state.failSessionSet = true;
    }
  };
});

const googleMocks = vi.hoisted(() => {
  const explicitMissing = { source: "explicit", result: "missing", attempts: 0, errorClass: "NONE", timeout: false };
  const capabilityDenied = { source: "imap_probe", result: "missing", attempts: 1, errorClass: "AUTHENTICATION_DENIED", timeout: false };
  const verificationFailed = { source: "imap_probe", result: "error", attempts: 2, errorClass: "NETWORK", timeout: false };
  class GmailImapScopeNotGrantedError extends Error {
    verification = explicitMissing;
  }
  class GoogleImapAuthenticationDeniedError extends Error {
    verification = capabilityDenied;
  }
  class GoogleTokenExchangeError extends Error {}
  class GoogleTokenScopeVerificationError extends Error {
    verification = verificationFailed;
  }
  return {
    GmailImapScopeNotGrantedError,
    GoogleImapAuthenticationDeniedError,
    GoogleTokenExchangeError,
    GoogleTokenScopeVerificationError,
    exchangeGoogleCode: vi.fn(),
    fetchGoogleUserInfo: vi.fn(),
    hasRequiredGmailImapScope: vi.fn((scope: string | undefined) => scope?.split(/\s+/).includes("https://mail.google.com/") === true),
    verifyGoogleTokenScopes: vi.fn(),
    upsertGoogleConnection: vi.fn()
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: cookieHarness.cookies
}));
vi.mock("@/lib/server/google-oauth", () => googleMocks);

describe("oauth runtime lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    cookieHarness.reset();
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    googleMocks.exchangeGoogleCode.mockReset();
    googleMocks.fetchGoogleUserInfo.mockReset();
    googleMocks.verifyGoogleTokenScopes.mockReset();
    googleMocks.upsertGoogleConnection.mockReset();
    googleMocks.exchangeGoogleCode.mockResolvedValue({ access_token: "access-token", scope: "openid email profile https://mail.google.com/" });
    googleMocks.verifyGoogleTokenScopes.mockImplementation(async (tokens) => ({
      ...tokens,
      scopeVerification: { source: "explicit", result: "success", attempts: 0, errorClass: "NONE", timeout: false }
    }));
    googleMocks.fetchGoogleUserInfo.mockResolvedValue({ sub: "google-user", email: "user@example.test" });
    googleMocks.upsertGoogleConnection.mockResolvedValue({ user: { id: "user-1" }, connection: { id: "connection-1" } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates and consumes one-time oauth state with localhost-safe cookie settings", async () => {
    const {
      OAUTH_STATE_COOKIE,
      appSessionCookieOptions,
      consumeOAuthState,
      createOAuthState,
      oauthStateCookieOptions
    } = await import("@/lib/server/session");

    const state = await createOAuthState("/app");
    expect(state).toHaveLength(32);
    expect(cookieHarness.jar.has(OAUTH_STATE_COOKIE)).toBe(true);
    expect(oauthStateCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 600
    });
    expect(appSessionCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/"
    });

    await expect(consumeOAuthState(state)).resolves.toEqual({ ok: true, returnTo: "/app" });
    expect(cookieHarness.jar.has(OAUTH_STATE_COOKIE)).toBe(false);
    await expect(consumeOAuthState(state)).resolves.toEqual({ ok: false, reason: "Missing OAuth state cookie." });
  });

  it("uses Secure cookies only when NODE_ENV is production", async () => {
    const { oauthStateCookieOptions } = await import("@/lib/server/session");

    expect(oauthStateCookieOptions().secure).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(oauthStateCookieOptions().secure).toBe(true);
  });

  it("supports immediate reconnect with fresh state, explicit Gmail scope, connection persistence, and a new session", async () => {
    const {
      OAUTH_STATE_COOKIE,
      SESSION_COOKIE,
      clearOAuthStateCookie,
      clearSessionCookie,
      consumeOAuthState,
      createOAuthState,
      getSession
    } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/google/callback/route");

    const firstState = await createOAuthState("/app/scan");
    const firstResponse = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=first-code&state=${firstState}`));

    expect(firstResponse.headers.get("location")).toBe("http://localhost:3000/app/scan");
    await expect(getSession()).resolves.toMatchObject({ userId: "user-1", providerConnectionId: "connection-1" });
    expect(cookieHarness.jar.has(OAUTH_STATE_COOKIE)).toBe(false);

    await clearOAuthStateCookie();
    await clearSessionCookie();
    expect(cookieHarness.jar.has(OAUTH_STATE_COOKIE)).toBe(false);
    expect(cookieHarness.jar.has(SESSION_COOKIE)).toBe(false);

    googleMocks.upsertGoogleConnection.mockResolvedValueOnce({ user: { id: "user-1" }, connection: { id: "connection-2" } });
    const secondState = await createOAuthState("/app/scan");
    expect(secondState).not.toBe(firstState);
    await expect(consumeOAuthState(firstState)).resolves.toEqual({ ok: false, reason: "OAuth state mismatch." });

    const thirdState = await createOAuthState("/app/scan");
    expect(thirdState).not.toBe(secondState);
    const secondResponse = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=second-code&state=${thirdState}`));

    expect(secondResponse.headers.get("location")).toBe("http://localhost:3000/app/scan");
    await expect(getSession()).resolves.toMatchObject({ userId: "user-1", providerConnectionId: "connection-2" });

    await clearOAuthStateCookie();
    await clearSessionCookie();
    googleMocks.upsertGoogleConnection.mockResolvedValueOnce({ user: { id: "user-1" }, connection: { id: "connection-3" } });
    const fourthState = await createOAuthState("/app/scan");
    expect(fourthState).not.toBe(thirdState);
    const thirdResponse = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=third-code&state=${fourthState}`));

    expect(thirdResponse.headers.get("location")).toBe("http://localhost:3000/app/scan");
    await expect(getSession()).resolves.toMatchObject({ userId: "user-1", providerConnectionId: "connection-3" });
    expect(googleMocks.exchangeGoogleCode).toHaveBeenCalledWith("first-code");
    expect(googleMocks.exchangeGoogleCode).toHaveBeenCalledWith("second-code");
    expect(googleMocks.exchangeGoogleCode).toHaveBeenCalledWith("third-code");
    expect(googleMocks.verifyGoogleTokenScopes).toHaveBeenCalledTimes(3);
    for (const call of googleMocks.verifyGoogleTokenScopes.mock.calls) {
      expect(call[0]).toMatchObject({ scope: "openid email profile https://mail.google.com/" });
    }
    expect(googleMocks.upsertGoogleConnection).toHaveBeenCalledTimes(3);
  });

  it("redirects missing or invalid state callbacks to retry UX before token exchange", async () => {
    const { GET } = await import("../app/api/oauth/google/callback/route");

    const response = await GET(new NextRequest("http://localhost:3000/api/oauth/google/callback?code=auth-code&state=missing-cookie"));

    expect(response.headers.get("location")).toBe("http://localhost:3000/connect/google/error?reason=missing_state_cookie");
    expect(googleMocks.exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it("consumes oauth state when Google returns a denial and rejects reuse", async () => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/google/callback/route");
    const state = await createOAuthState("/app/scan");

    const denied = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?error=access_denied&state=${state}`));
    const reused = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=auth-code&state=${state}`));

    expect(denied.headers.get("location")).toBe("http://localhost:3000/connect/google/error?reason=oauth_denied");
    expect(denied.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(reused.headers.get("location")).toBe("http://localhost:3000/connect/google/error?reason=missing_state_cookie");
    expect(googleMocks.exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it.each([
    [new googleMocks.GmailImapScopeNotGrantedError(), "gmail_scope"],
    [new googleMocks.GoogleImapAuthenticationDeniedError(), "gmail_capability_denied"],
    [new googleMocks.GoogleTokenScopeVerificationError(), "scope_verification_failed"],
    [new googleMocks.GoogleTokenExchangeError(), "token_exchange_failed"]
  ])("classifies callback failures without conflating scope denial and verification", async (failure, reason) => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/google/callback/route");
    const state = await createOAuthState("/app/scan");

    if (failure instanceof googleMocks.GoogleTokenExchangeError) {
      googleMocks.exchangeGoogleCode.mockRejectedValueOnce(failure);
    } else {
      googleMocks.verifyGoogleTokenScopes.mockRejectedValueOnce(failure);
    }

    const response = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=auth-code&state=${state}`));

    expect(response.headers.get("location")).toBe(`http://localhost:3000/connect/google/error?reason=${reason}`);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(googleMocks.upsertGoogleConnection).not.toHaveBeenCalled();
  });

  it("loads userinfo before the IMAP fallback when the token response omits scope", async () => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/google/callback/route");
    googleMocks.exchangeGoogleCode.mockResolvedValueOnce({ access_token: "access-token" });
    googleMocks.verifyGoogleTokenScopes.mockImplementationOnce(async (tokens, accountEmail) => ({
      ...tokens,
      scope: "openid email profile https://mail.google.com/",
      scopeVerification: { source: "imap_probe", result: "success", attempts: 2, errorClass: "NONE", timeout: false },
      accountEmail
    }));
    const state = await createOAuthState("/app/scan");

    const response = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=auth-code&state=${state}`));

    expect(response.headers.get("location")).toBe("http://localhost:3000/app/scan");
    expect(googleMocks.fetchGoogleUserInfo).toHaveBeenCalledBefore(googleMocks.verifyGoogleTokenScopes);
    expect(googleMocks.verifyGoogleTokenScopes).toHaveBeenCalledWith(expect.objectContaining({ access_token: "access-token" }), "user@example.test");
    expect(googleMocks.fetchGoogleUserInfo).toHaveBeenCalledTimes(1);
  });

  it("emits the safe completed stage record for a missing-scope fallback in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/google/callback/route");
    googleMocks.exchangeGoogleCode.mockResolvedValueOnce({ access_token: "access-token" });
    googleMocks.verifyGoogleTokenScopes.mockResolvedValueOnce({
      access_token: "access-token",
      scope: "openid email profile https://mail.google.com/",
      scopeVerification: { source: "imap_probe", result: "success", attempts: 2, errorClass: "NONE", timeout: false }
    });
    const state = await createOAuthState("/app/scan");

    await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=auth-code&state=${state}`));

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      state_validation: "success",
      token_exchange: "success",
      token_scope_field_present: false,
      explicit_scope_check: "not_applicable",
      fallback_scope_verification_started: true,
      fallback_scope_verification_result: "success",
      fallback_attempts: 2,
      fallback_http_status: "not_applicable",
      fallback_error_class: "NONE",
      fallback_timeout: false,
      userinfo: "success",
      provider_connection_save: "success",
      session_creation: "success",
      final_result: "success"
    });
    const serialized = JSON.stringify(info.mock.calls);
    for (const forbidden of ["access-token", "auth-code", state, "user@example.test", "user-1", "connection-1"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("classifies userinfo failure distinctly", async () => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/google/callback/route");
    googleMocks.fetchGoogleUserInfo.mockRejectedValueOnce(new Error("userinfo unavailable"));
    const state = await createOAuthState("/app/scan");

    const response = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=auth-code&state=${state}`));

    expect(response.headers.get("location")).toBe("http://localhost:3000/connect/google/error?reason=userinfo_failed");
    expect(googleMocks.upsertGoogleConnection).not.toHaveBeenCalled();
  });

  it("classifies ProviderConnection save failure distinctly", async () => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/google/callback/route");
    googleMocks.upsertGoogleConnection.mockRejectedValueOnce(new Error("database unavailable"));
    const state = await createOAuthState("/app/scan");

    const response = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=auth-code&state=${state}`));

    expect(response.headers.get("location")).toBe("http://localhost:3000/connect/google/error?reason=provider_connection_save_failed");
  });

  it("classifies session creation failure distinctly", async () => {
    const { createOAuthState } = await import("@/lib/server/session");
    const { GET } = await import("../app/api/oauth/google/callback/route");
    const state = await createOAuthState("/app/scan");
    cookieHarness.failSessionSet();

    const response = await GET(new NextRequest(`http://localhost:3000/api/oauth/google/callback?code=auth-code&state=${state}`));

    expect(response.headers.get("location")).toBe("http://localhost:3000/connect/google/error?reason=session_creation_failed");
  });
});
