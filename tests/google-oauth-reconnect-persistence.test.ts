import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
  findFirst: vi.fn(),
  sha256Base64Url: vi.fn((value: string) => `hash:${value}`),
  update: vi.fn(),
  userUpsert: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("imapflow", () => ({ ImapFlow: class {} }));
vi.mock("@/lib/server/crypto", () => ({
  encryptSecret: mocks.encryptSecret,
  sha256Base64Url: mocks.sha256Base64Url
}));
vi.mock("@/lib/server/db", () => ({
  prisma: {
    providerConnection: {
      create: mocks.create,
      findFirst: mocks.findFirst,
      update: mocks.update
    },
    user: { upsert: mocks.userUpsert }
  }
}));

import { upsertGoogleConnection } from "@/lib/server/google-oauth";

describe("Google OAuth reconnect persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userUpsert.mockResolvedValue({ id: "user-1" });
    mocks.findFirst.mockResolvedValue({
      id: "connection-1",
      disconnectedAt: new Date(),
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      encryptedAccountEmail: null
    });
    mocks.update.mockResolvedValue({ id: "connection-1" });
  });

  it("reactivates a scrubbed ProviderConnection using only credentials from the fresh OAuth callback", async () => {
    await upsertGoogleConnection(
      {
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        expires_in: 3600,
        scope: "openid email profile https://mail.google.com/",
        scopeVerification: { source: "explicit", result: "success", attempts: 0, errorClass: "NONE", timeout: false }
      },
      { sub: "fresh-google-subject", email: "user@example.test" }
    );

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "connection-1" },
      data: expect.objectContaining({
        encryptedAccountEmail: "encrypted:user@example.test",
        encryptedAccessToken: "encrypted:fresh-access-token",
        encryptedRefreshToken: "encrypted:fresh-refresh-token",
        scope: "openid email profile https://mail.google.com/",
        disconnectedAt: null
      })
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain("old-");
  });
});
