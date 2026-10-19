import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getUserEntitlement } from "@/lib/billing/entitlements";
import { environment } from "./fixtures/credit-billing";

const db = vi.hoisted(() => ({
  user: { findUniqueOrThrow: vi.fn() }, billingAccount: { findUnique: vi.fn() },
  creditJobAccounting: { findMany: vi.fn() }
}));
vi.mock("@/lib/server/db", () => ({ prisma: db }));
vi.mock("@/lib/billing/stripe", () => ({ createStripeClient: () => ({}) }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  db.user.findUniqueOrThrow.mockResolvedValue({ creditOwnerId: "owner" });
  db.billingAccount.findUnique.mockResolvedValue({ stripeCustomerId: "customer", livemode: false, creditBalance: 1000, syncedAt: new Date() });
  db.creditJobAccounting.findMany.mockResolvedValue([{ requested: 300, moved: 100 }]);
});
afterEach(() => vi.unstubAllEnvs());

it("resolves owner, fresh account and reservations once per request without a second account snapshot", async () => {
  const entitlement = await getUserEntitlement("linked-user");
  expect(entitlement).toMatchObject({ balance: 1000, reserved: 200, available: 800, paidAccess: true });
  expect(db.user.findUniqueOrThrow).toHaveBeenCalledOnce();
  expect(db.billingAccount.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { userId: "owner" } });
  expect(db.creditJobAccounting.findMany).toHaveBeenCalledExactlyOnceWith({
    where: { userId: "owner", closed: false, activeStateJobId: { not: null } }, select: { requested: true, moved: true }
  });
});

it("never reuses an earlier account's entitlement across independent calls", async () => {
  expect((await getUserEntitlement("first")).available).toBe(800);
  db.user.findUniqueOrThrow.mockResolvedValue({ creditOwnerId: null });
  db.billingAccount.findUnique.mockResolvedValue(null);
  db.creditJobAccounting.findMany.mockResolvedValue([]);
  expect(await getUserEntitlement("second")).toMatchObject({ available: 0, paidAccess: false, state: "free" });
  expect(db.billingAccount.findUnique).toHaveBeenLastCalledWith({ where: { userId: "second" } });
});
