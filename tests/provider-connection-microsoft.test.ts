import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getActiveMicrosoftConnection: vi.fn(),
  getSession: vi.fn(),
  decryptSecret: vi.fn(() => "gmail@example.test")
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ runtimeConfig: { fixtureMode: false } }));
vi.mock("@/lib/server/db", () => ({ prisma: { providerConnection: { findFirst: mocks.findFirst } } }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/server/crypto", () => ({ decryptSecret: mocks.decryptSecret }));
vi.mock("@/lib/server/microsoft-connection", () => ({
  getActiveMicrosoftConnection: mocks.getActiveMicrosoftConnection
}));

import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";

describe("canonical Microsoft provider connection state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ userId: "user-1", providerConnectionId: "connection-1" });
  });

  it("resolves a valid Microsoft connection through the provider-neutral session record", async () => {
    const microsoft = connection({ provider: "microsoft", encryptedAccountEmail: "encrypted-email" });
    mocks.findFirst.mockResolvedValue(microsoft);
    mocks.getActiveMicrosoftConnection.mockResolvedValue({
      connection: microsoft,
      accountEmail: "person@example.test"
    });

    await expect(getCurrentProviderConnection()).resolves.toMatchObject({
      mode: "connected",
      provider: "microsoft",
      providerConnectionId: "connection-1",
      accountEmail: "person@example.test"
    });
    expect(mocks.getActiveMicrosoftConnection).toHaveBeenCalledWith("user-1", "connection-1");
  });

  it("requires reconnect when Microsoft refresh credentials or mail scope are absent", async () => {
    mocks.findFirst.mockResolvedValue(connection({
      provider: "microsoft",
      encryptedRefreshToken: null,
      scope: "Mail.Read"
    }));
    await expect(getCurrentProviderConnection()).resolves.toMatchObject({
      mode: "needs_reconnect",
      provider: "microsoft"
    });
    expect(mocks.getActiveMicrosoftConnection).not.toHaveBeenCalled();
  });

  it("preserves the existing Gmail resolution path", async () => {
    mocks.findFirst.mockResolvedValue(connection({
      provider: "gmail",
      encryptedAccountEmail: "encrypted-gmail-email",
      scope: "openid email profile https://mail.google.com/"
    }));
    await expect(getCurrentProviderConnection()).resolves.toMatchObject({
      mode: "connected",
      provider: "gmail",
      accountEmail: "gmail@example.test"
    });
    expect(mocks.getActiveMicrosoftConnection).not.toHaveBeenCalled();
  });
});

function connection(overrides: Record<string, unknown>) {
  return {
    id: "connection-1",
    userId: "user-1",
    provider: "microsoft",
    encryptedAccessToken: "encrypted-access",
    encryptedRefreshToken: "encrypted-refresh",
    encryptedAccountEmail: null,
    scope: "Mail.ReadWrite",
    disconnectedAt: null,
    ...overrides
  };
}
