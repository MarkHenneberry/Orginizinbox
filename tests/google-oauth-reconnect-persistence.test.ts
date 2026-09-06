import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
  findFirst: vi.fn(),
  sha256Base64Url: vi.fn((value: string) => `hash:${value}`),
  update: vi.fn(),
  upsert: vi.fn(),
  userUpsert: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("imapflow", () => ({ ImapFlow: class {} }));
vi.mock("@/lib/server/crypto", () => ({
  encryptSecret: mocks.encryptSecret,
  sha256Base64Url: mocks.sha256Base64Url
}));
vi.mock("@/lib/server/db", () => {
  const transaction = {
    providerConnection: {
      create: mocks.create,
      findFirst: mocks.findFirst,
      update: mocks.update,
      upsert: mocks.upsert
    },
    user: { upsert: mocks.userUpsert }
  };
  return {
    prisma: {
      ...transaction,
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    }
  };
});

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
    mocks.upsert.mockResolvedValue({ id: "connection-1" });
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

    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { userId_provider: { userId: "user-1", provider: "gmail" } },
      update: expect.objectContaining({
        encryptedAccountEmail: "encrypted:user@example.test",
        encryptedAccessToken: "encrypted:fresh-access-token",
        encryptedRefreshToken: "encrypted:fresh-refresh-token",
        scope: "openid email profile https://mail.google.com/",
        disconnectedAt: null
      }),
      create: expect.objectContaining({ userId: "user-1", provider: "gmail" })
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.upsert.mock.calls)).not.toContain("old-");
  });
});
