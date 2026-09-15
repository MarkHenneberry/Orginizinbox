import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), find: vi.fn(), refresh: vi.fn(), report: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/server/db", () => ({ prisma: { providerConnection: { findFirst: mocks.find }, scanState: { updateMany: mocks.write } } }));
vi.mock("@/lib/server/microsoft-connection", () => ({ getActiveMicrosoftConnection: mocks.refresh }));
vi.mock("@/lib/server/live-scan-store", () => ({ getLiveScan: mocks.report, hasExpiredLiveScan: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://example.test");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/fixture");
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", "t".repeat(32));
  vi.stubEnv("CLEANUP_STATE_ENCRYPTION_KEY", "s".repeat(32));
  vi.stubEnv("CRON_SECRET", "fixture-cron");
  vi.stubEnv("GMAIL_PRODUCTION_ENABLED", "true");
  vi.stubEnv("MICROSOFT_PRODUCTION_ENABLED", "false");
  vi.stubEnv("GOOGLE_CLIENT_ID", "fixture");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture");
  vi.stubEnv("GOOGLE_REDIRECT_URI", "https://example.test/api/oauth/google/callback");
  mocks.session.mockResolvedValue({ userId: "owner", providerConnectionId: "connection" });
  mocks.find.mockResolvedValue({ id: "connection", userId: "owner", provider: "microsoft", encryptedAccessToken: "encrypted-placeholder" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("connected provider maintenance", () => {
  it("preserves connections and reports without refreshing a disabled provider", async () => {
    const { getCurrentProviderConnection } = await import("@/lib/server/provider-connection-state");
    const { getAppHomeState, getPublicPrimaryCta } = await import("@/lib/server/app-state");
    const { getAccountConnectionState } = await import("@/lib/server/account-state");
    expect(await getCurrentProviderConnection()).toMatchObject({ mode: "unavailable", provider: "microsoft" });
    expect(await getAppHomeState()).toEqual({ mode: "unavailable", provider: "microsoft" });
    expect(await getAccountConnectionState(true)).toEqual({ mode: "unavailable", provider: "microsoft", hasActiveReport: false });
    expect(await getPublicPrimaryCta()).toEqual({ href: "/connect", label: "View provider availability" });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("fences disabled scans and all development cleanup before durable/provider access", async () => {
    const { createScanRequestFence, createCleanupRequestFence } = await import("@/lib/server/provider-work-fence");
    await expect(createScanRequestFence("scan", "owner", "microsoft")()).rejects.toMatchObject({ name: "AbortError" });
    await expect(createCleanupRequestFence({ id: "connection", userId: "owner", provider: "gmail", sessionGeneration: "generation" }, "job")())
      .rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
