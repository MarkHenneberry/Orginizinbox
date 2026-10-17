import type { PrismaClient, ProviderConnection } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../app/api/app/inbox/switch/route";
import { getLinkedInboxes } from "@/lib/server/linked-inboxes";
import { getSession, setSessionCookie, SESSION_COOKIE } from "@/lib/server/session";
import { creditSnapshot } from "@/lib/billing/credits";
import { encryptSecret } from "@/lib/server/crypto";

const fixture = vi.hoisted(() => {
  type Where = { id?: string; userId?: string; sessionGeneration?: string; disconnectedAt?: null;
    encryptedAccessToken?: { not: null }; user?: { OR: Array<{ id?: string; creditOwnerId?: string }> } };
  const rows = new Map<string, ProviderConnection>();
  const users = new Map<string, { id: string; creditOwnerId: string | null }>();
  const jar = new Map<string, string>();
  const state = { busy: false, beforeTransaction: undefined as (() => void) | undefined };
  const match = (where: Where, row: ProviderConnection) => (!where.id || row.id === where.id) && (!where.userId || row.userId === where.userId) &&
    (where.disconnectedAt === undefined || row.disconnectedAt === null) && (!where.encryptedAccessToken || row.encryptedAccessToken !== null) &&
    (!where.sessionGeneration || row.sessionGeneration === where.sessionGeneration) &&
    (!where.user || where.user.OR.some(member => member.id === row.userId || Boolean(member.creditOwnerId && users.get(row.userId)?.creditOwnerId === member.creditOwnerId)));
  const db = {
    user: { findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id)!) },
    providerConnection: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => [...rows.values()].find(row => match(where, row)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Where }) => [...rows.values()].filter(row => match(where, row))),
      update: vi.fn(async ({ where, data }: { where: Where; data: { sessionGeneration: string } }) => {
        const row = [...rows.values()].find(row => match(where, row));
        if (!row) throw new Error("missing");
        Object.assign(row, data); return { id: row.id };
      })
    },
    cleanupJobState: { count: vi.fn(async () => state.busy ? 1 : 0) },
    billingAccount: { findUnique: vi.fn(async () => ({ creditBalance: 59990 })), update: vi.fn() },
    creditJobAccounting: { findMany: vi.fn(async () => [{ requested: 25, moved: 5 }]) },
    creditEntry: { create: vi.fn() }, inboxLinkIntent: { updateMany: vi.fn() },
    $queryRaw: vi.fn(async () => [])
  };
  const transaction = vi.fn(async (fn: (tx: typeof db) => Promise<unknown>) => {
    state.beforeTransaction?.();
    return fn(db);
  });
  return { rows, users, jar, state, db, transaction, report: vi.fn(), config: { gmailAvailable: true, microsoftAvailable: true } };
});
vi.mock("@/lib/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://example.test", TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") }, runtimeConfig: fixture.config }));
vi.mock("@/lib/server/db", () => ({ prisma: { ...fixture.db, $transaction: fixture.transaction } }));
vi.mock("@/lib/server/live-scan-store", () => ({ getLiveScan: fixture.report }));
vi.mock("next/headers.js", () => ({ cookies: async () => ({ get: (key: string) => ({ value: fixture.jar.get(key) }),
  set: (key: string, value: string) => { fixture.jar.set(key, value); } }) }));

beforeEach(async () => {
  vi.clearAllMocks(); fixture.jar.clear(); fixture.rows.clear(); fixture.users.clear();
  fixture.state.busy = false; fixture.state.beforeTransaction = undefined;
  fixture.config.gmailAvailable = true; fixture.config.microsoftAvailable = true;
  fixture.report.mockResolvedValue(undefined);
  for (const [id, owner, provider] of [["gmail", "outlook", "gmail"], ["outlook", null, "microsoft"], ["stranger", null, "gmail"]] as const) {
    fixture.users.set(id, { id, creditOwnerId: owner });
    fixture.rows.set(id, { id, userId: id, provider, encryptedAccessToken: encryptSecret("access"), encryptedRefreshToken: encryptSecret("refresh"),
      encryptedAccountEmail: encryptSecret(`${id}@example.test`), disconnectedAt: null, tokenExpiresAt: new Date(Date.now() + 3600000),
      scope: provider === "gmail" ? "https://mail.google.com/" : "Mail.ReadWrite", sessionGeneration: null } as ProviderConnection);
  }
  await setSessionCookie({ userId: "gmail", providerConnectionId: "gmail", createdAt: Date.now() });
});
const request = (connectionId = "outlook", origin = "https://example.test") => new Request("https://example.test/api/app/inbox/switch", {
  method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ connectionId, creditOwnerId: "stranger" })
});

it("switches both ways using secure sessions, preserves source workers, balances and reservations, and never writes financial/link state", async () => {
  const sourceGeneration = fixture.rows.get("gmail")!.sessionGeneration;
  const before = await creditSnapshot(fixture.db as unknown as PrismaClient, "gmail");
  expect((await POST(request())).status).toBe(200);
  expect(await getSession()).toMatchObject({ userId: "outlook", providerConnectionId: "outlook" });
  expect(fixture.rows.get("outlook")!.sessionGeneration).toMatch(/^[a-f0-9]{64}$/);
  expect(fixture.rows.get("gmail")!.sessionGeneration).toBe(sourceGeneration);
  expect(await creditSnapshot(fixture.db as unknown as PrismaClient, "outlook")).toEqual(before);
  expect((await POST(request("gmail"))).status).toBe(200);
  expect(await getSession()).toMatchObject({ userId: "gmail" });
  expect(fixture.rows.get("gmail")!.sessionGeneration).not.toBe(sourceGeneration);
  expect(fixture.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  expect(fixture.db.creditEntry.create).not.toHaveBeenCalled();
  expect(fixture.db.billingAccount.update).not.toHaveBeenCalled();
  expect(fixture.db.inboxLinkIntent.updateMany).not.toHaveBeenCalled();
  expect(fixture.users.get("gmail")!.creditOwnerId).toBe("outlook");
});
it.each(["stranger", "missing"])("rejects unrelated/missing %s without changing the current cookie", async target => {
  const original = fixture.jar.get(SESSION_COOKIE);
  expect((await POST(request(target))).status).toBe(403);
  expect(fixture.jar.get(SESSION_COOKIE)).toBe(original);
});
it.each(["disconnect", "access", "refresh", "scope", "decryption", "disabled"])("fails closed on target %s", async reason => {
  const row = fixture.rows.get("outlook")!;
  if (reason === "disconnect") row.disconnectedAt = new Date();
  if (reason === "access") row.encryptedAccessToken = null;
  if (reason === "refresh") row.encryptedRefreshToken = null;
  if (reason === "scope") row.scope = "openid";
  if (reason === "decryption") row.encryptedAccessToken = "invalid";
  if (reason === "disabled") fixture.config.microsoftAvailable = false;
  const original = fixture.jar.get(SESSION_COOKIE);
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe(reason === "disabled" ? "unavailable" : "needs_reconnect");
  expect(fixture.jar.get(SESSION_COOKIE)).toBe(original);
});
it("allows ordinary expired-token refresh credentials but rejects expired Gmail without refresh", async () => {
  fixture.rows.get("outlook")!.tokenExpiresAt = new Date(0);
  expect((await POST(request())).status).toBe(200);
  fixture.rows.get("gmail")!.tokenExpiresAt = new Date(0);
  fixture.rows.get("gmail")!.encryptedRefreshToken = null;
  expect((await POST(request("gmail"))).status).toBe(409);
});
it.each(["generation", "membership", "lease"])("rechecks %s at the activation transaction boundary", async reason => {
  const original = fixture.jar.get(SESSION_COOKIE);
  fixture.state.beforeTransaction = () => {
    if (reason === "generation") fixture.rows.get("gmail")!.sessionGeneration = "revoked";
    if (reason === "membership") fixture.users.get("gmail")!.creditOwnerId = "stranger";
    if (reason === "lease") fixture.state.busy = true;
  };
  const response = await POST(request());
  expect(response.status).toBe(reason === "lease" ? 409 : reason === "generation" ? 401 : 403);
  expect(fixture.jar.get(SESSION_COOKIE)).toBe(original);
});
it("preserves idle recovery state, blocks active target cleanup, and scopes the check to the target connection", async () => {
  fixture.state.busy = true;
  const response = await POST(request());
  expect((await response.json()).code).toBe("operation_active");
  expect(fixture.db.cleanupJobState.count).toHaveBeenCalledWith({ where: expect.objectContaining({ userId: "outlook", job: { scan: { providerConnectionId: "outlook" } } }) });
  fixture.state.busy = false;
  expect((await POST(request())).status).toBe(200);
  expect(fixture.db.$queryRaw).toHaveBeenCalled();
});
it.each([true, false])("routes only from the target's current report (present: %s)", async hasReport => {
  fixture.report.mockImplementation(async (userId, provider) => userId === "outlook" && provider === "microsoft" && hasReport
    ? { report: {}, progress: { status: "completed", provider: "microsoft" } } : undefined);
  const response = await POST(request());
  expect(await response.json()).toEqual({ url: hasReport ? "/app/report" : "/app/scan" });
  expect(fixture.report).toHaveBeenCalledWith("outlook", "microsoft");
});
it("returns only safe group presentation, including reconnect state, never secret columns", async () => {
  fixture.rows.get("outlook")!.disconnectedAt = new Date();
  const list = await getLinkedInboxes();
  expect(list).toEqual([
    { id: "gmail", provider: "gmail", email: "gmail@example.test", active: true, state: "ready" },
    { id: "outlook", provider: "microsoft", email: "outlook@example.test", active: false, state: "needs_reconnect" }
  ]);
  expect(JSON.stringify(list)).not.toMatch(/token|scope|Generation|stranger|creditOwner|encrypted/);
});
it("requires same-origin and authenticated requests", async () => {
  expect((await POST(request("outlook", "https://attacker.test"))).status).toBe(403);
  fixture.jar.clear();
  expect((await POST(request())).status).toBe(401);
});
it("an old source cookie stays source-scoped and cannot activate an unrelated owner", async () => {
  const old = fixture.jar.get(SESSION_COOKIE)!;
  expect((await POST(request())).status).toBe(200);
  fixture.jar.set(SESSION_COOKIE, old);
  expect(await getSession()).toMatchObject({ userId: "gmail" });
  expect((await POST(request("stranger"))).status).toBe(403);
  expect(await getSession()).toMatchObject({ userId: "gmail" });
});
it("an already-active target is a no-op and cannot interrupt its worker by rotating generation", async () => {
  fixture.state.busy = true;
  const before = fixture.rows.get("gmail")!.sessionGeneration;
  expect((await POST(request("gmail"))).status).toBe(200);
  expect(fixture.rows.get("gmail")!.sessionGeneration).toBe(before);
  expect(fixture.transaction).not.toHaveBeenCalled();
});
