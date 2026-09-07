import { readFileSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { purgeExpiredTransientState } from "@/lib/server/transient-state-purge";
import { PrismaCleanupJobStateRepository, PrismaCleanupJobStore } from "@/lib/server/gmail-scalable-cleanup-durable-store";
import { GET, HEAD } from "../app/api/cron/purge-transient-state/route";

const db = vi.hoisted(() => ({ scanState: {}, cleanupJobState: {} }));
vi.mock("@/lib/server/db", () => ({ prisma: db }));

const now = new Date("2026-09-07T12:00:00Z");
const before = new Date(now.getTime() - 1);
const after = new Date(now.getTime() + 60_000);
type Row = {
  id: string;
  userId: string;
  provider: "gmail" | "microsoft";
  expiresAt: Date;
  lockExpiresAt: Date | null;
  encryptedPayload: string;
  status: string;
  version: number;
};
type Where = {
  expiresAt?: { lte: Date };
  OR?: Array<{ lockExpiresAt: null | { lte: Date } }>;
  lockExpiresAt?: { gt: Date };
  scanId?: { in: string[] } | string;
  jobId?: { in: string[] } | string;
};

function table(key: "scanId" | "jobId", initial: Row[] = []) {
  const rows = new Map(initial.map((row) => [row.id, row]));
  const matches = (row: Row, where: Where) => {
    const ids = where[key];
    if (typeof ids === "string" ? ids !== row.id : ids && !ids.in.includes(row.id)) return false;
    if (where.expiresAt && row.expiresAt > where.expiresAt.lte) return false;
    if (where.lockExpiresAt && (!row.lockExpiresAt || row.lockExpiresAt <= where.lockExpiresAt.gt)) return false;
    if (where.OR && !where.OR.some((clause) => clause.lockExpiresAt === null
      ? row.lockExpiresAt === null
      : row.lockExpiresAt !== null && row.lockExpiresAt <= clause.lockExpiresAt.lte)) return false;
    return true;
  };
  return {
    rows,
    findMany: vi.fn(async ({ where, select, take }: { where: Where; select: Record<string, boolean>; take: number }) => {
      expect(select).toEqual({ [key]: true });
      return [...rows.values()].filter((row) => matches(row, where)).slice(0, take).map((row) => ({ [key]: row.id }));
    }),
    findUnique: vi.fn(async ({ where }: { where: Where }) => {
      const row = [...rows.values()].find((row) => matches(row, where));
      return row ? { ...structuredClone(row), [key]: row.id } : null;
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      let count = 0;
      for (const [id, row] of rows) if (matches(row, where) && rows.delete(id)) count += 1;
      return { count };
    }),
    count: vi.fn(async ({ where }: { where: Where }) => [...rows.values()].filter((row) => matches(row, where)).length)
  };
}

function row(id: string, patch: Partial<Row> = {}): Row {
  return {
    id, userId: `user-${id}`, provider: "gmail", expiresAt: before, lockExpiresAt: null,
    encryptedPayload: "PRIVATE-MAILBOX-CIPHERTEXT", status: "complete", version: 1, ...patch
  };
}

function database(scans: Row[] = [], jobs: Row[] = []) {
  const scanState = table("scanId", scans);
  const cleanupJobState = table("jobId", jobs);
  Object.assign(db, { scanState, cleanupJobState });
  return { scanState, cleanupJobState, client: db as unknown as PrismaClient };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Provider access is forbidden in retention tests."); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("provider-neutral physical retention", () => {
  it("deletes expired Gmail/Outlook state across users, including abandoned running rows, without reading payloads", async () => {
    const { client, scanState, cleanupJobState } = database(
      [row("gmail"), row("outlook", { provider: "microsoft", status: "running", lockExpiresAt: before })],
      [row("job-gmail"), row("job-outlook", { provider: "microsoft", expiresAt: now })]
    );
    const result = await purgeExpiredTransientState(client, now);
    expect(result).toMatchObject({ status: "success", scans: { deleted: 2 }, cleanup: { deleted: 2 } });
    expect(scanState.rows.size + cleanupJobState.rows.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|gmail|outlook|job-|user-|Payload|Id/);
  });

  it("preserves every non-expired status and defers expired state with a live worker lease", async () => {
    const statuses = ["running", "created", "ready", "paused", "mutating", "complete", "partial", "failed", "undoing"];
    const records = statuses.map((status) => row(status, { status, expiresAt: after }));
    records.push(row("lease", { lockExpiresAt: after }));
    const { client, scanState, cleanupJobState } = database(structuredClone(records), structuredClone(records));
    const result = await purgeExpiredTransientState(client, now);
    expect(result.scans).toEqual({ deleted: 0, deferred: 1, remaining: 0, status: "success" });
    expect(result.cleanup).toEqual(result.scans);
    expect(scanState.rows.size).toBe(records.length);
    expect(cleanupJobState.rows.size).toBe(records.length);
    expect((await purgeExpiredTransientState(client, after)).scans.deleted).toBe(records.length);
  });

  it("is idempotent under overlapping sweeps", async () => {
    const { client } = database([row("scan")], [row("job")]);
    const results = await Promise.all([purgeExpiredTransientState(client, now), purgeExpiredTransientState(client, now)]);
    expect(results.reduce((sum, value) => sum + value.scans.deleted + value.cleanup.deleted, 0)).toBe(2);
    expect(await purgeExpiredTransientState(client, now)).toMatchObject({ scans: { deleted: 0 }, cleanup: { deleted: 0 } });
  });

  it.each(["expiry", "lease"] as const)("rechecks a concurrently renewed %s for BOTH tables", async (renewal) => {
    const { client, scanState, cleanupJobState } = database([row("scan")], [row("job")]);
    for (const [delegate, id] of [[scanState, "scan"], [cleanupJobState, "job"]] as const) {
      const remove = delegate.deleteMany.getMockImplementation()!;
      delegate.deleteMany.mockImplementationOnce(async (args) => {
        const current = delegate.rows.get(id)!;
        if (renewal === "expiry") current.expiresAt = after;
        else current.lockExpiresAt = after;
        return remove(args);
      });
    }
    const result = await purgeExpiredTransientState(client, now);
    expect(result.scans.deleted + result.cleanup.deleted).toBe(0);
    expect(scanState.rows.has("scan") && cleanupJobState.rows.has("job")).toBe(true);
  });

  it("bounds each sweep and drains backlog on the next invocation", async () => {
    const { client, scanState } = database(Array.from({ length: 5001 }, (_, index) => row(`scan-${index}`)));
    const result = await purgeExpiredTransientState(client, now);
    expect(result.scans).toMatchObject({ deleted: 5000, remaining: 1 });
    expect(scanState.findMany).toHaveBeenCalledTimes(10);
    expect((await purgeExpiredTransientState(client, now)).scans).toMatchObject({ deleted: 1, remaining: 0 });
  });

  it("continues the other table after failure and returns only fixed aggregate-safe diagnostics", async () => {
    const { client, scanState } = database([row("scan")], [row("job")]);
    scanState.findMany.mockRejectedValueOnce(new Error("secret=TOKEN sender@example.com raw payload https://private"));
    const result = await purgeExpiredTransientState(client, now);
    expect(result).toMatchObject({ status: "failed", scans: { status: "failed", remaining: null }, cleanup: { deleted: 1 } });
    expect(JSON.stringify(result)).not.toMatch(/secret|TOKEN|sender|payload|https/);
    expect((await purgeExpiredTransientState(client, now)).scans.deleted).toBe(1);
  });

  it("makes access-time expiry deletion conditional and scoped to the exact job", async () => {
    const { client, cleanupJobState } = database([], [row("expired"), row("other")]);
    const decode = vi.fn();
    const store = new PrismaCleanupJobStore(new PrismaCleanupJobStateRepository(client), { encode: vi.fn(), decode });
    const remove = cleanupJobState.deleteMany.getMockImplementation()!;
    cleanupJobState.deleteMany.mockImplementationOnce(async (args) => {
      cleanupJobState.rows.get("expired")!.expiresAt = after;
      return remove(args);
    });
    expect(await store.getByJobId("expired", now)).toBeUndefined();
    expect(cleanupJobState.rows.size).toBe(2);
    expect(decode).not.toHaveBeenCalled();
    cleanupJobState.rows.get("expired")!.expiresAt = before;
    expect(await store.compareAndSet("user-expired", "expired", 1, (job) => job, now)).toBeUndefined();
    expect(cleanupJobState.rows.has("expired")).toBe(false);
    expect(cleanupJobState.rows.has("other")).toBe(true);
  });

  it("does not let an access-time purge delete a live lease", async () => {
    const { client, cleanupJobState } = database([], [row("leased", { lockExpiresAt: after })]);
    const store = new PrismaCleanupJobStore(new PrismaCleanupJobStateRepository(client));
    expect(await store.getByJobId("leased", now)).toBeUndefined();
    expect(cleanupJobState.rows.has("leased")).toBe(true);
  });
});

describe("scheduled purge boundary", () => {
  const request = (authorization?: string) => new Request("http://localhost/api/cron/purge-transient-state?cutoff=2099-01-01", {
    headers: authorization ? { authorization } : {}
  });

  it("fails closed without configuration/authentication and rejects implicit HEAD execution", async () => {
    const { scanState } = database();
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(request())).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "fixture-cron-secret");
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    expect((await GET(request("Bearer fixture-cron-secrex"))).status).toBe(401);
    expect(HEAD().status).toBe(405);
    expect(scanState.findMany).not.toHaveBeenCalled();
  });

  it("runs authenticated, ignores caller cutoff, disables caching and logs aggregate counts only", async () => {
    database([row("PRIVATE-SCAN-ID"), row("unexpired", { expiresAt: after })]);
    vi.stubEnv("CRON_SECRET", "fixture-cron-secret");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await GET(request("Bearer fixture-cron-secret"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ scans: { deleted: 1 } });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|user-|fixture-cron-secret|cutoff|http/);
  });

  it("returns a non-success HTTP status on database failure without logging database error details", async () => {
    const { scanState } = database();
    scanState.findMany.mockRejectedValue(new Error("PRIVATE-SQL-PARAMETERS"));
    vi.stubEnv("CRON_SECRET", "fixture-cron-secret");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await GET(request("Bearer fixture-cron-secret"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE");
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
  });

  it("schedules the authenticated endpoint every minute, without secrets in config", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(config.crons).toEqual([{ path: "/api/cron/purge-transient-state", schedule: "* * * * *" }]);
    expect(JSON.stringify(config)).not.toMatch(/secret|token|authorization/i);
  });
});
