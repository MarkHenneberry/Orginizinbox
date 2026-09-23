import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConnection } from "@prisma/client";
import type { GmailConnectionDiagnostic } from "@/lib/server/gmail-scan-failure";

const mocks = vi.hoisted(() => ({ config: { gmailAvailable: true }, find: vi.fn(), decrypt: vi.fn(), refresh: vi.fn(), google: vi.fn() }));
vi.mock("@/lib/config", () => ({ runtimeConfig: mocks.config }));
vi.mock("@/lib/server/db", () => ({ prisma: { providerConnection: { findFirst: mocks.find } } }));
vi.mock("@/lib/server/crypto", () => ({ decryptSecret: mocks.decrypt }));
vi.mock("@/lib/server/provider-token-refresh", () => ({ refreshProviderConnectionSingleFlight: mocks.refresh }));
vi.mock("@/lib/server/google-oauth", () => ({
  gmailMissingImapScopeMessage: "Missing required scope",
  hasRequiredGmailImapScope: (scope: string) => scope?.split(" ").includes("https://mail.google.com/"),
  refreshGoogleAccessToken: mocks.google
}));
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";

let row: ProviderConnection;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  mocks.config.gmailAvailable = true;
  row = { encryptedAccessToken: "access", encryptedAccountEmail: "email", encryptedRefreshToken: "refresh",
    scope: "https://mail.google.com/", tokenExpiresAt: new Date(Date.now() + 3600_000) } as ProviderConnection;
  mocks.find.mockImplementation(async () => row);
  mocks.decrypt.mockImplementation((value) => `decrypted-${value}`);
  mocks.refresh.mockImplementation(async () => row);
});
afterEach(() => vi.unstubAllEnvs());

describe("request-local Gmail connection diagnostic", () => {
  it("preserves success and emits no failure", async () => {
    const diagnostic: GmailConnectionDiagnostic = { failureReason: "unknown_connection_failure" };
    const result = await getActiveGmailConnection("owner", "connection", diagnostic);
    expect(result).toEqual({ connection: row, accessToken: "decrypted-access", accountEmail: "decrypted-email", refreshToken: "decrypted-refresh" });
    expect(diagnostic).toEqual({});
    expect(mocks.find).toHaveBeenCalledWith({ where: { id: "connection", userId: "owner", provider: "gmail", disconnectedAt: null } });
  });
  it.each(["runtime_config_unavailable", "connection_record_missing", "connection_credentials_missing"] as const)("preserves null for %s", async (reason) => {
    if (reason === "runtime_config_unavailable") mocks.config.gmailAvailable = false;
    if (reason === "connection_record_missing") mocks.find.mockResolvedValue(null);
    if (reason === "connection_credentials_missing") row.encryptedAccountEmail = null;
    const diagnostic: GmailConnectionDiagnostic = {};
    expect(await getActiveGmailConnection("owner", "connection", diagnostic)).toBeNull();
    expect(diagnostic).toEqual({ failureReason: reason });
    if (reason === "runtime_config_unavailable") expect(mocks.find).not.toHaveBeenCalled();
  });
  it.each([
    ["connection_lookup_failed", "lookup"], ["token_refresh_failed", "refresh"],
    ["access_token_decrypt_failed", "access"], ["account_email_decrypt_failed", "email"],
    ["refresh_token_decrypt_failed", "refresh-decrypt"]
  ])("preserves the exact exception for %s", async (reason, operation) => {
    const error = new Error("PRIVATE exception with credentials and identifiers");
    if (operation === "lookup") mocks.find.mockRejectedValue(error);
    else if (operation === "refresh") {
      row.tokenExpiresAt = new Date(0);
      mocks.refresh.mockRejectedValue(error);
    } else mocks.decrypt.mockImplementation((value) => {
      if (value === (operation === "refresh-decrypt" ? "refresh" : operation)) throw error;
      return "decrypted";
    });
    const diagnostic: GmailConnectionDiagnostic = {};
    await expect(getActiveGmailConnection("owner", "connection", diagnostic)).rejects.toBe(error);
    expect(diagnostic).toEqual({ failureReason: reason });
  });
  it.each(["gmail_scope_missing", "token_expired_no_refresh_token", "token_refresh_access_token_missing", "token_refresh_scope_missing"] as const)("classifies %s", async (reason) => {
    if (reason === "gmail_scope_missing") row.scope = "openid";
    else {
      row.tokenExpiresAt = new Date(0);
      if (reason === "token_expired_no_refresh_token") row.encryptedRefreshToken = null;
      else {
        mocks.refresh.mockImplementation(async (input) => { await input.refresh("fixture"); return row; });
        mocks.google.mockResolvedValue(reason === "token_refresh_access_token_missing" ? {} : { access_token: "fixture", scope: "openid" });
      }
    }
    const diagnostic: GmailConnectionDiagnostic = {};
    await expect(getActiveGmailConnection("owner", "connection", diagnostic)).rejects.toThrow();
    expect(diagnostic).toEqual({ failureReason: reason });
  });
  it("does not share reasons across concurrent callers", async () => {
    mocks.find.mockImplementation(async ({ where }) => where.userId === "missing" ? null : row);
    const missing: GmailConnectionDiagnostic = {};
    const valid: GmailConnectionDiagnostic = {};
    await Promise.all([getActiveGmailConnection("missing", undefined, missing), getActiveGmailConnection("valid", undefined, valid)]);
    expect(missing.failureReason).toBe("connection_record_missing");
    expect(valid).toEqual({});
  });
});
