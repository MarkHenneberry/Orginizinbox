import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const imapHarness = vi.hoisted(() => ({
  createClient: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/db", () => ({ prisma: {} }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(options: unknown) {
      return imapHarness.createClient(options);
    }
  }
}));

import {
  GmailImapScopeNotGrantedError,
  GoogleImapAuthenticationDeniedError,
  GoogleTokenScopeVerificationError,
  verifyGoogleTokenScopes
} from "@/lib/server/google-oauth";
import { gmailRequiredImapScope } from "@/lib/providers/gmail/scopes";

function successfulClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn()
  };
}

function failedClient(error: Error & { code?: string; authenticationFailed?: boolean; responseStatus?: string }) {
  return {
    connect: vi.fn().mockRejectedValue(error),
    close: vi.fn()
  };
}

describe("Google access-token scope verification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    imapHarness.createClient.mockReset();
    imapHarness.createClient.mockImplementation(() => successfulClient());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts an explicit token response containing the Gmail IMAP scope without a fallback", async () => {
    const verified = await verifyGoogleTokenScopes({
      access_token: "test-access-token",
      scope: `openid email profile ${gmailRequiredImapScope}`
    });

    expect(verified.scope).toContain(gmailRequiredImapScope);
    expect(verified.scopeVerification).toEqual({ source: "explicit", result: "success", attempts: 0, errorClass: "NONE", timeout: false });
    expect(imapHarness.createClient).not.toHaveBeenCalled();
  });

  it("rejects an explicit token response that proves the Gmail IMAP scope is absent", async () => {
    await expect(
      verifyGoogleTokenScopes({ access_token: "test-access-token", scope: "openid email profile" })
    ).rejects.toBeInstanceOf(GmailImapScopeNotGrantedError);
    expect(imapHarness.createClient).not.toHaveBeenCalled();
  });

  it("uses authentication-only Gmail IMAP verification when the token response omits scope", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const verified = await verifyGoogleTokenScopes({ access_token: "test-access-token" }, "user@example.test");

    expect(verified.scope).toContain(gmailRequiredImapScope);
    expect(verified.scopeVerification).toEqual({ source: "imap_probe", result: "success", attempts: 1, errorClass: "NONE", timeout: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(imapHarness.createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "imap.gmail.com",
        logger: false,
        verifyOnly: true,
        includeMailboxes: false,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 5_000,
        auth: { user: "user@example.test", accessToken: "test-access-token" }
      })
    );
  });

  it("retries one transient IMAP failure and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    imapHarness.createClient
      .mockReturnValueOnce(failedClient(Object.assign(new Error("reset"), { code: "ECONNRESET" })))
      .mockReturnValueOnce(successfulClient());

    const verification = verifyGoogleTokenScopes({ access_token: "test-access-token" }, "user@example.test");
    await vi.advanceTimersByTimeAsync(150);

    await expect(verification).resolves.toMatchObject({
      scopeVerification: { source: "imap_probe", result: "success", attempts: 2, errorClass: "NONE", timeout: false }
    });
    expect(imapHarness.createClient).toHaveBeenCalledTimes(2);
  });

  it("returns a technical verification error after two transient failures", async () => {
    vi.useFakeTimers();
    imapHarness.createClient.mockImplementation(() => failedClient(Object.assign(new Error("reset"), { code: "ECONNRESET" })));

    const verification = verifyGoogleTokenScopes({ access_token: "test-access-token" }, "user@example.test");
    const rejection = expect(verification).rejects.toMatchObject({
      verification: { source: "imap_probe", result: "error", attempts: 2, errorClass: "NETWORK", timeout: false }
    });
    await vi.advanceTimersByTimeAsync(150);

    await rejection;
    await expect(verification).rejects.toBeInstanceOf(GoogleTokenScopeVerificationError);
    await expect(verification).rejects.not.toBeInstanceOf(GmailImapScopeNotGrantedError);
    expect(imapHarness.createClient).toHaveBeenCalledTimes(2);
  });

  it("classifies IMAP authentication denial separately and does not retry", async () => {
    imapHarness.createClient.mockReturnValueOnce(
      failedClient(Object.assign(new Error("denied"), { authenticationFailed: true, responseStatus: "NO" }))
    );

    const verification = verifyGoogleTokenScopes({ access_token: "test-access-token" }, "user@example.test");

    await expect(verification).rejects.toBeInstanceOf(GoogleImapAuthenticationDeniedError);
    await expect(verification).rejects.toMatchObject({
      verification: { source: "imap_probe", result: "missing", attempts: 1, errorClass: "AUTHENTICATION_DENIED", timeout: false }
    });
    await expect(verification).rejects.not.toBeInstanceOf(GmailImapScopeNotGrantedError);
    expect(imapHarness.createClient).toHaveBeenCalledTimes(1);
  });

  it("bounds stalled probes, retries once, and records timeout without provider details", async () => {
    vi.useFakeTimers();
    imapHarness.createClient.mockImplementation(() => ({ connect: vi.fn(() => new Promise(() => undefined)), close: vi.fn() }));

    const verification = verifyGoogleTokenScopes({ access_token: "test-access-token" }, "user@example.test");
    const rejection = expect(verification).rejects.toMatchObject({
      verification: { source: "imap_probe", result: "error", attempts: 2, errorClass: "TIMEOUT", timeout: true }
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(7_000);

    await rejection;
    expect(imapHarness.createClient).toHaveBeenCalledTimes(2);
  });
});
