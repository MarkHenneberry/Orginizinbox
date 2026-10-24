import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/crypto")>();
  return {
    ...actual,
    encryptSecret: (value: string) => `encrypted:${value}`,
    decryptSecret: (value: string) => value.replace(/^encrypted:/, "")
  };
});

import { refreshProviderConnectionSingleFlight } from "@/lib/server/provider-token-refresh";
import { createProviderRequestCoordinator } from "@/lib/server/provider-request-coordinator";

describe("provider multi-user coordination", () => {
  it("backs off occupied request slots within the existing wall-time budget", async () => {
    let clock = 0;
    const claim = vi.fn(async () => ({ count: 0 }));
    const fence = vi.fn(async () => {});
    const work = vi.fn(async () => {});
    const coordinate = createProviderRequestCoordinator("occupied", { limit: 2, client: {
      providerRequestLease: { upsert: vi.fn(async () => ({})), updateMany: claim }
    } as never, now: () => new Date(clock), sleep: async ms => { clock += ms; }, random: () => 0, beforeRequest: fence });
    await expect(coordinate(work)).rejects.toThrow("busy");
    expect(clock).toBe(12_000);
    expect(claim.mock.calls.length).toBeLessThan(40);
    expect(fence).toHaveBeenCalledTimes(claim.mock.calls.length / 2);
    expect(work).not.toHaveBeenCalled();
  });

  it("observes a live refresh lease without doomed claim writes and consumes the rotated version", async () => {
    const state = providerConnection();
    state.refreshLeaseOwner = "winner"; state.refreshLeaseExpiresAt = new Date(30_000);
    const client = tokenClient(state);
    const claim = vi.spyOn(client.providerConnection, "updateMany");
    const read = vi.spyOn(client.providerConnection, "findFirst");
    let clock = 0;
    const refresh = vi.fn();
    const result = await refreshProviderConnectionSingleFlight({ userId: state.userId, connection: structuredClone(state),
      provider: "microsoft", force: true, refreshSkewMs: 60_000, refresh, client: client as never,
      now: () => new Date(clock), random: () => 0, sleep: async ms => {
        clock += ms;
        if (clock >= 5_000) { state.tokenVersion++; state.encryptedRefreshToken = "encrypted:rotated"; }
      }
    });
    expect(result.tokenVersion).toBe(1); expect(result.encryptedRefreshToken).toBe("encrypted:rotated");
    expect(claim).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    expect(read.mock.calls.length).toBeLessThan(12);
  });

  it("single-flights simultaneous rotated-token refreshes by connection version", async () => {
    const state = providerConnection();
    const client = tokenClient(state);
    const refresh = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
        scope: "Mail.ReadWrite"
      };
    });
    const input = {
      userId: "user-1",
      connection: structuredClone(state),
      provider: "microsoft" as const,
      force: true,
      refreshSkewMs: 60_000,
      refresh,
      client: client as never,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
      random: () => 0
    };

    const [first, second] = await Promise.all([
      refreshProviderConnectionSingleFlight(input),
      refreshProviderConnectionSingleFlight(input)
    ]);

    expect(refresh).toHaveBeenCalledOnce();
    expect(first.tokenVersion).toBe(1);
    expect(second.tokenVersion).toBe(1);
    expect(first.encryptedRefreshToken).toBe("encrypted:refresh-1");
    expect(second.encryptedRefreshToken).toBe("encrypted:refresh-1");
  });

  it.each([false, true])("bounds one connection while allowing another user's work (post-claim fence: %s)", async (fenceAfterClaimOnly) => {
    const leaseClient = requestLeaseClient();
    const firstUser = createProviderRequestCoordinator("connection-a", {
      fenceAfterClaimOnly,
      limit: 1,
      client: leaseClient as never,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
      random: () => 0
    });
    const secondUser = createProviderRequestCoordinator("connection-b", {
      fenceAfterClaimOnly,
      limit: 1,
      client: leaseClient as never,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
      random: () => 0
    });
    let activeA = 0;
    let maxA = 0;
    let activeTotal = 0;
    let maxTotal = 0;
    const work = (connection: "a" | "b") => async () => {
      if (connection === "a") maxA = Math.max(maxA, ++activeA);
      activeTotal += 1;
      maxTotal = Math.max(maxTotal, activeTotal);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeTotal -= 1;
      if (connection === "a") activeA -= 1;
    };

    await Promise.all([firstUser(work("a")), firstUser(work("a")), secondUser(work("b"))]);

    expect(maxA).toBe(1);
    expect(maxTotal).toBe(2);
  });

  it("enforces schema and source-level atomic ownership boundaries", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const gmailAcceptance = readFileSync("src/lib/server/gmail-scalable-live-workflow.ts", "utf8");
    const outlookAcceptance = readFileSync("src/lib/server/outlook-cleanup.ts", "utf8");
    const googleOAuth = readFileSync("src/lib/server/google-oauth.ts", "utf8");
    const microsoftOAuth = readFileSync("src/lib/server/microsoft-oauth.ts", "utf8");

    expect(schema).toContain("@@unique([userId, provider])");
    expect(schema).toContain("@@unique([scanId, acceptanceKey])");
    expect(schema).toContain("@@id([userId, provider])");
    expect(`${gmailAcceptance}\n${outlookAcceptance}`).not.toMatch(/take:\s*10[\s\S]+acceptanceKey/);
    expect(gmailAcceptance).toMatch(/cleanupJob\.create[\s\S]+cleanupJobState\.create/);
    expect(outlookAcceptance).toMatch(/cleanupJob\.create[\s\S]+createPreparedCleanupJobState\(transaction, prepared\)/);
    expect(googleOAuth).toContain("userId_provider");
    expect(microsoftOAuth).toContain("userId_provider");
  });
});

function providerConnection() {
  return {
    id: "connection-1",
    userId: "user-1",
    provider: "microsoft" as const,
    mailboxExternalIdHash: "mailbox-hash",
    encryptedAccountEmail: "encrypted:person@example.test",
    encryptedAccessToken: "encrypted:access-0",
    encryptedRefreshToken: "encrypted:refresh-0",
    encryptedImapAccessToken: null as string | null,
    encryptedImapRefreshToken: null as string | null,
    imapTokenExpiresAt: null as Date | null,
    imapScope: null as string | null,
    tokenExpiresAt: new Date(Date.now() - 1),
    scope: "Mail.ReadWrite",
    tokenVersion: 0,
    sessionGeneration: null as string | null,
    refreshLeaseOwner: null as string | null,
    refreshLeaseExpiresAt: null as Date | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    disconnectedAt: null as Date | null
  };
}

function tokenClient(state: ReturnType<typeof providerConnection>) {
  return {
    providerConnection: {
      async findFirst() {
        return structuredClone(state);
      },
      async updateMany(input: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        const where = input.where as {
          tokenVersion?: number;
          refreshLeaseOwner?: string;
        };
        if (where.tokenVersion !== undefined && where.tokenVersion !== state.tokenVersion) return { count: 0 };
        if (where.refreshLeaseOwner && state.refreshLeaseOwner !== where.refreshLeaseOwner) return { count: 0 };
        if (Array.isArray(input.where.OR) && state.refreshLeaseOwner) return { count: 0 };
        if (typeof input.data.refreshLeaseOwner === "string") {
          state.refreshLeaseOwner = input.data.refreshLeaseOwner;
          state.refreshLeaseExpiresAt = input.data.refreshLeaseExpiresAt as Date;
          return { count: 1 };
        }
        if (input.data.tokenVersion) {
          state.encryptedAccessToken = input.data.encryptedAccessToken as string;
          state.encryptedRefreshToken = input.data.encryptedRefreshToken as string;
          state.tokenExpiresAt = input.data.tokenExpiresAt as Date;
          state.scope = input.data.scope as string;
          state.tokenVersion += 1;
        }
        state.refreshLeaseOwner = null;
        state.refreshLeaseExpiresAt = null;
        return { count: 1 };
      }
    }
  };
}

function requestLeaseClient() {
  const rows = new Map<string, { leaseOwner: string | null; leaseExpiresAt: Date | null }>();
  return {
    providerRequestLease: {
      async upsert(input: { where: { providerConnectionId_slot: { providerConnectionId: string; slot: number } } }) {
        const key = `${input.where.providerConnectionId_slot.providerConnectionId}:${input.where.providerConnectionId_slot.slot}`;
        if (!rows.has(key)) rows.set(key, { leaseOwner: null, leaseExpiresAt: null });
        return rows.get(key);
      },
      async updateMany(input: { where: { providerConnectionId: string; slot: number; leaseOwner?: string }; data: { leaseOwner: string | null; leaseExpiresAt: Date | null } }) {
        const key = `${input.where.providerConnectionId}:${input.where.slot}`;
        const row = rows.get(key);
        if (!row) return { count: 0 };
        if (input.where.leaseOwner && row.leaseOwner !== input.where.leaseOwner) return { count: 0 };
        if (!input.where.leaseOwner && row.leaseOwner && row.leaseExpiresAt && row.leaseExpiresAt > new Date()) return { count: 0 };
        row.leaseOwner = input.data.leaseOwner;
        row.leaseExpiresAt = input.data.leaseExpiresAt;
        return { count: 1 };
      }
    }
  };
}
