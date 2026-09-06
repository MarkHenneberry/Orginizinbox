import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptSecret: vi.fn((value: string) => value.replace("encrypted:", "")),
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
  findFirst: vi.fn(),
  refreshMicrosoftAccessToken: vi.fn(),
  refreshSingleFlight: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/crypto", () => ({
  decryptSecret: mocks.decryptSecret,
  encryptSecret: mocks.encryptSecret
}));
vi.mock("@/lib/server/db", () => ({
  prisma: {
    providerConnection: {
      findFirst: mocks.findFirst
    }
  }
}));
vi.mock("@/lib/server/provider-token-refresh", () => ({
  refreshProviderConnectionSingleFlight: mocks.refreshSingleFlight
}));
vi.mock("@/lib/server/microsoft-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/microsoft-oauth")>();
  return { ...actual, refreshMicrosoftAccessToken: mocks.refreshMicrosoftAccessToken };
});

import {
  forceRefreshMicrosoftConnection,
  getActiveMicrosoftConnection,
  MicrosoftReconnectRequiredError
} from "@/lib/server/microsoft-connection";

describe("Microsoft connection refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue(connection({ tokenExpiresAt: new Date(Date.now() + 3_600_000) }));
    mocks.refreshSingleFlight.mockImplementation(async (input: {
      refresh(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken?: string;
        tokenExpiresAt?: Date | null;
        scope?: string | null;
      }>;
    }) => {
      const result = await input.refresh("refresh-token");
      return connection({
        encryptedAccessToken: `encrypted:${result.accessToken}`,
        encryptedRefreshToken: `encrypted:${result.refreshToken ?? "refresh-token"}`,
        tokenExpiresAt: result.tokenExpiresAt,
        scope: result.scope,
        tokenVersion: 1
      });
    });
  });

  it("returns a valid unexpired connection without refreshing", async () => {
    await expect(getActiveMicrosoftConnection("user-1", "connection-1")).resolves.toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accountEmail: "person@example.test"
    });
    expect(mocks.refreshMicrosoftAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token and persists refresh-token rotation", async () => {
    mocks.findFirst.mockResolvedValue(connection({ tokenExpiresAt: new Date(Date.now() - 1) }));
    mocks.refreshMicrosoftAccessToken.mockResolvedValue({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
      scope: "Mail.ReadWrite"
    });

    await expect(getActiveMicrosoftConnection("user-1", "connection-1")).resolves.toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh"
    });
    expect(mocks.refreshMicrosoftAccessToken).toHaveBeenCalledWith("refresh-token");
    expect(mocks.refreshSingleFlight).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      provider: "microsoft"
    }));
  });

  it("requires reconnect after refresh rejection, revocation, or missing mail scope", async () => {
    mocks.findFirst.mockResolvedValue(connection({ tokenExpiresAt: new Date(Date.now() - 1) }));
    mocks.refreshMicrosoftAccessToken.mockRejectedValue(new Error("invalid_grant"));
    await expect(getActiveMicrosoftConnection("user-1", "connection-1")).rejects.toBeInstanceOf(MicrosoftReconnectRequiredError);

    mocks.findFirst.mockResolvedValue(connection({ scope: "Mail.Read" }));
    await expect(getActiveMicrosoftConnection("user-1", "connection-1")).rejects.toThrow(/permission was not granted/i);
  });

  it("forces and persists a refresh when Graph rejects an otherwise unexpired token", async () => {
    mocks.refreshMicrosoftAccessToken.mockResolvedValue({
      access_token: "forced-access",
      refresh_token: "forced-refresh",
      expires_in: 3600,
      scope: "Mail.ReadWrite"
    });

    await expect(forceRefreshMicrosoftConnection("user-1", "connection-1")).resolves.toBe("forced-access");
    expect(mocks.refreshMicrosoftAccessToken).toHaveBeenCalledWith("refresh-token");
    expect(mocks.refreshSingleFlight).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });
});

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection-1",
    provider: "microsoft",
    encryptedAccessToken: "encrypted:access-token",
    encryptedRefreshToken: "encrypted:refresh-token",
    encryptedAccountEmail: "encrypted:person@example.test",
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    scope: "Mail.ReadWrite",
    disconnectedAt: null,
    tokenVersion: 0,
    refreshLeaseOwner: null,
    refreshLeaseExpiresAt: null,
    ...overrides
  };
}
