import type { PrismaClient } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { upsertGoogleConnection } from "@/lib/server/google-oauth";
import { upsertMicrosoftConnection } from "@/lib/server/microsoft-oauth";
import { creditSnapshot } from "@/lib/billing/credits";

const harness = vi.hoisted(() => {
  type User = { id: string; creditOwnerId: string | null };
  const state = {
    users: new Map<string, User>(), accounts: new Map<string, { creditBalance: number }>(),
    consumed: false, failSave: false, failConsume: false, target: "gmail", generation: "source-generation"
  };
  const tx = {
    user: {
      upsert: vi.fn(async ({ where }: { where: { microsoftIdentityHash?: string } }) => {
        const id = where.microsoftIdentityHash ? "outlook" : state.target;
        if (!state.users.has(id)) state.users.set(id, { id, creditOwnerId: null });
        return { ...state.users.get(id)! };
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...state.users.get(where.id)!, billingAccount: state.accounts.get(where.id) ?? null })),
      count: vi.fn(async ({ where }: { where: { creditOwnerId: string } }) => [...state.users.values()].filter(user => user.creditOwnerId === where.creditOwnerId).length),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { creditOwnerId: string } }) => Object.assign(state.users.get(where.id)!, data))
    },
    providerConnection: {
      count: vi.fn(async ({ where }: { where: { sessionGeneration: string } }) => where.sessionGeneration === state.generation ? 1 : 0),
      upsert: vi.fn(async ({ where }: { where: { userId_provider: { userId: string } } }) => {
        if (state.failSave) throw new Error("credential save failed");
        if (where.userId_provider.userId === "outlook") state.generation = "rotated";
        return { id: `${where.userId_provider.userId}-connection` };
      })
    },
    inboxLinkIntent: {
      findUnique: vi.fn(async () => ({ id: "intent", sourceUserId: "outlook", sourceConnectionId: "source", sourceGeneration: "source-generation", provider: "gmail", expiresAt: new Date(Date.now() + 600000), consumedAt: state.consumed ? new Date() : null })),
      updateMany: vi.fn(async () => { if (state.failConsume || state.consumed) return { count: 0 }; state.consumed = true; return { count: 1 }; })
    },
    billingAccount: {
      create: vi.fn(async ({ data }: { data: { userId: string } }) => { if (state.accounts.has(data.userId)) throw new Error("unique billing account"); state.accounts.set(data.userId, { creditBalance: 0 }); }),
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => state.accounts.get(where.userId) ?? null)
    },
    creditPurchase: { count: vi.fn(async () => 0) },
    creditJobAccounting: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    cleanupJobState: { count: vi.fn(async () => 0) },
    creditEntry: { create: vi.fn() },
    scanState: { updateMany: vi.fn(), deleteMany: vi.fn() }
  };
  const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
    const before = structuredClone(state);
    try { return await fn(tx); } catch (error) { Object.assign(state, before); throw error; }
  });
  return { state, tx, transaction };
});
vi.mock("@/lib/server/db", () => ({ prisma: { ...harness.tx, $transaction: harness.transaction } }));
vi.mock("@/lib/server/crypto", () => ({ encryptSecret: (value: string) => `encrypted:${value}`, sha256Base64Url: (value: string) => `hash:${value}` }));
vi.mock("imapflow", () => ({ ImapFlow: class {} }));

const tokens = { access_token: "fixture", refresh_token: "fixture", scope: "openid https://mail.google.com/",
  scopeVerification: { source: "explicit", result: "success", attempts: 0, errorClass: "NONE", timeout: false } } as const;
const profile = { sub: "fixture", email: "fixture@example.test" };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(harness.state, { users: new Map([["outlook", { id: "outlook", creditOwnerId: null }]]),
    accounts: new Map([["outlook", { creditBalance: 59990 }]]), consumed: false, failSave: false, failConsume: false, target: "gmail", generation: "source-generation" });
});

it("atomically links the verified Gmail target to the funded Outlook owner; reconnects retain one balance and separate report identities", async () => {
  const saved = await upsertGoogleConnection(tokens, profile, "intent");
  expect(saved.user.id).toBe("gmail");
  expect(harness.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  expect(harness.state.consumed).toBe(true);
  expect(harness.state.users.get("gmail")?.creditOwnerId).toBe("outlook");
  const db = harness.tx as unknown as PrismaClient;
  for (const id of ["gmail", "outlook"]) expect(await creditSnapshot(db, id)).toEqual({ available: 59990, reserved: 0, balance: 59990 });
  expect(1 + await harness.tx.user.count({ where: { creditOwnerId: "outlook" } })).toBe(2);
  await upsertGoogleConnection(tokens, profile);
  await upsertMicrosoftConnection({ access_token: "fixture", refresh_token: "fixture", id_token: "fixture", scope: "Mail.ReadWrite", identity: { tenantId: "fixture", subject: "fixture" } });
  expect((await creditSnapshot(db, "gmail")).available).toBe(59990);
  expect((await creditSnapshot(db, "outlook")).available).toBe(59990);
  expect(harness.tx.creditEntry.create).not.toHaveBeenCalled();
  expect(harness.tx.scanState.updateMany).not.toHaveBeenCalled();
  expect(harness.tx.scanState.deleteMany).not.toHaveBeenCalled();
  expect([...harness.state.users.keys()]).toEqual(["outlook", "gmail"]);
});

it.each(["save", "consume", "same-inbox", "generation"])("rolls back %s failure without altering source ownership, balance or credentials", async (failure) => {
  if (failure === "save") harness.state.failSave = true;
  if (failure === "consume") harness.state.failConsume = true;
  if (failure === "same-inbox") harness.state.target = "outlook";
  if (failure === "generation") harness.state.generation = "changed";
  const before = structuredClone(harness.state);
  await expect(upsertGoogleConnection(tokens, profile, "intent")).rejects.toThrow();
  expect(harness.state).toEqual(before);
  if (failure !== "save") expect(harness.tx.providerConnection.upsert).not.toHaveBeenCalled();
  expect(harness.tx.creditEntry.create).not.toHaveBeenCalled();
});
