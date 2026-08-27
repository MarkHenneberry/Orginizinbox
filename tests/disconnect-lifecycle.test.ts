import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearGmailCleanupJobsForUser: vi.fn(),
  clearLiveScan: vi.fn(),
  clearOAuthStateCookie: vi.fn(),
  clearSessionCookie: vi.fn(),
  decryptSecret: vi.fn(() => "decrypted-token"),
  findFirst: vi.fn(),
  getSession: vi.fn(),
  revokeGoogleToken: vi.fn(),
  update: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/crypto", () => ({ decryptSecret: mocks.decryptSecret }));
vi.mock("@/lib/server/db", () => ({
  prisma: { providerConnection: { findFirst: mocks.findFirst, update: mocks.update } }
}));
vi.mock("@/lib/server/gmail-cleanup-store", () => ({ clearGmailCleanupJobsForUser: mocks.clearGmailCleanupJobsForUser }));
vi.mock("@/lib/server/google-oauth", () => ({ revokeGoogleToken: mocks.revokeGoogleToken }));
vi.mock("@/lib/server/live-scan-store", () => ({ clearLiveScan: mocks.clearLiveScan }));
vi.mock("@/lib/server/session", () => ({
  clearOAuthStateCookie: mocks.clearOAuthStateCookie,
  clearSessionCookie: mocks.clearSessionCookie,
  getSession: mocks.getSession
}));

import { disconnectCurrentGmailSession, removeCurrentGoogleAuthorization } from "@/lib/server/disconnect";

const clearedConnectionData = {
  mailboxExternalIdHash: null,
  encryptedAccountEmail: null,
  encryptedAccessToken: null,
  encryptedRefreshToken: null,
  tokenExpiresAt: null,
  scope: null,
  disconnectedAt: expect.any(Date)
};

describe("Gmail disconnect lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.getSession.mockResolvedValue({ userId: "user-1", providerConnectionId: "connection-1" });
    mocks.findFirst.mockResolvedValue({
      id: "connection-1",
      encryptedRefreshToken: "encrypted-refresh-token",
      encryptedAccessToken: "encrypted-access-token"
    });
    mocks.update.mockResolvedValue({});
    mocks.revokeGoogleToken.mockResolvedValue({ succeeded: true, status: 200 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("normal Disconnect destroys all local provider and transient state without calling Google revoke", async () => {
    await expect(disconnectCurrentGmailSession()).resolves.toEqual({
      disconnected: true,
      mode: "local_disconnect",
      revocationAttempted: false,
      revocationSucceeded: false,
      revocationStatus: null
    });

    expect(mocks.decryptSecret).not.toHaveBeenCalled();
    expect(mocks.revokeGoogleToken).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "connection-1" }, data: clearedConnectionData });
    expect(mocks.clearOAuthStateCookie).toHaveBeenCalledOnce();
    expect(mocks.clearLiveScan).toHaveBeenCalledWith("user-1");
    expect(mocks.clearGmailCleanupJobsForUser).toHaveBeenCalledWith("user-1");
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
  });

  it("Remove Google authorization prefers the refresh token and then clears all local state", async () => {
    await expect(removeCurrentGoogleAuthorization()).resolves.toEqual({
      disconnected: true,
      mode: "remote_revoke",
      revocationAttempted: true,
      revocationSucceeded: true,
      revocationStatus: 200
    });

    expect(mocks.decryptSecret).toHaveBeenCalledWith("encrypted-refresh-token");
    expect(mocks.revokeGoogleToken).toHaveBeenCalledWith("decrypted-token");
    expect(mocks.revokeGoogleToken.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "connection-1" }, data: clearedConnectionData });
    expect(mocks.clearLiveScan).toHaveBeenCalledWith("user-1");
    expect(mocks.clearGmailCleanupJobsForUser).toHaveBeenCalledWith("user-1");
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
  });

  it("falls back to the access token when remote authorization removal has no refresh token", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "connection-1",
      encryptedRefreshToken: null,
      encryptedAccessToken: "encrypted-access-token"
    });

    await removeCurrentGoogleAuthorization();

    expect(mocks.decryptSecret).toHaveBeenCalledWith("encrypted-access-token");
    expect(mocks.revokeGoogleToken).toHaveBeenCalledWith("decrypted-token");
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "connection-1" }, data: clearedConnectionData });
  });

  it("still destroys every local credential and transient state when Google revocation fails", async () => {
    mocks.revokeGoogleToken.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(removeCurrentGoogleAuthorization()).resolves.toEqual({
      disconnected: true,
      mode: "remote_revoke",
      revocationAttempted: true,
      revocationSucceeded: false,
      revocationStatus: null
    });

    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "connection-1" }, data: clearedConnectionData });
    expect(mocks.clearOAuthStateCookie).toHaveBeenCalledOnce();
    expect(mocks.clearLiveScan).toHaveBeenCalledWith("user-1");
    expect(mocks.clearGmailCleanupJobsForUser).toHaveBeenCalledWith("user-1");
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
  });

  it("keeps credentials and account identifiers out of development diagnostics", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await removeCurrentGoogleAuthorization();

    const diagnostic = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(diagnostic).toContain("remote_revocation_status");
    for (const forbidden of ["encrypted-refresh-token", "encrypted-access-token", "decrypted-token", "user-1", "connection-1"]) {
      expect(diagnostic).not.toContain(forbidden);
    }
  });

  it("does not emit disconnect diagnostics in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await removeCurrentGoogleAuthorization();

    expect(console.info).not.toHaveBeenCalled();
  });
});
