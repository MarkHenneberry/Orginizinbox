import { beforeEach, expect, it, vi } from "vitest";
import { getCreditPresentation, getLinkedInboxCount } from "@/lib/server/credit-presentation";
const mocks = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), account: vi.fn(), holds: vi.fn(), count: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/server/db", () => ({ prisma: { user: { findUniqueOrThrow: mocks.user, count: mocks.count }, billingAccount: { findUnique: mocks.account }, creditJobAccounting: { findMany: mocks.holds } } }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ userId: "linked-user" });
  mocks.user.mockResolvedValue({ creditOwnerId: "shared-owner" });
  mocks.account.mockResolvedValue({ creditBalance: 60500 });
  mocks.holds.mockResolvedValue([{ requested: 500, moved: 0 }]);
  mocks.count.mockResolvedValue(1);
});
it("uses the shared owner and subtracts active reservations for the header/Account balance", async () => {
  expect(await getCreditPresentation()).toEqual({ available: 60000, reserved: 500, balance: 60500 });
  expect(mocks.account).toHaveBeenCalledWith({ where: { userId: "shared-owner" } });
  expect(await getLinkedInboxCount()).toBe(2);
  expect(mocks.count).toHaveBeenCalledWith({ where: { creditOwnerId: "shared-owner" } });
});
it("does not present missing authentication or failed reads as zero credits", async () => {
  mocks.session.mockResolvedValue(null);
  expect(await getCreditPresentation()).toBeNull();
  expect(mocks.account).not.toHaveBeenCalled();
  mocks.session.mockRejectedValue(new Error("private"));
  expect(await getCreditPresentation()).toBeNull();
});
