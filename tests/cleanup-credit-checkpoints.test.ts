import { expect, it, vi } from "vitest";
import { PrismaCleanupJobStore, type CleanupJobStateRepository } from "@/lib/server/cleanup-job-store";
import type { OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";

it("keeps every job CAS but skips unchanged financial writes; reservation, verified move, close and restore remain financial boundaries", async () => {
  const job = { userId: "owner", version: 1, creditBilling: true, provider: "microsoft",
    view: { id: "job", requested: 1, status: "running", expiresAt: Date.now() + 60_000 },
    payload: { confirmedAt: 1, targets: [{ state: "frozen" }] } } as unknown as OutlookCleanupStoredJob & { creditBilling: true };
  const row = { jobId: "job", userId: "owner", version: 1, expiresAt: new Date(job.view.expiresAt), encryptedPayload: JSON.stringify(job) };
  const repository = { find: vi.fn(async () => structuredClone(row)), replaceIfVersion: vi.fn(async (input: Parameters<CleanupJobStateRepository["replaceIfVersion"]>[0]) => Boolean(input)) };
  const store = new PrismaCleanupJobStore(repository as unknown as CleanupJobStateRepository,
    { encode: JSON.stringify, decode: value => JSON.parse(value) as typeof job });
  await store.compareAndSet("owner", "job", 1, value => value);
  expect(repository.replaceIfVersion.mock.calls[0][0]).toHaveProperty("creditProgress", undefined);
  for (const state of ["moved_verified", "restored_verified"] as const) {
    await store.compareAndSet("owner", "job", 1, value => { value.payload.targets[0].state = state; return value; });
    expect(repository.replaceIfVersion.mock.calls.at(-1)![0]).toMatchObject({ creditProgress: {
      requested: 1, moved: 1, restored: state === "restored_verified" ? 1 : 0, closed: false
    } });
  }
  await store.compareAndSet("owner", "job", 1, value => { value.view.status = "complete"; return value; });
  expect(repository.replaceIfVersion.mock.calls.at(-1)![0]).toMatchObject({ creditProgress: { closed: true } });
  const unconfirmed = structuredClone(job); delete (unconfirmed.payload as Partial<typeof unconfirmed.payload>).confirmedAt;
  row.encryptedPayload = JSON.stringify(unconfirmed);
  await store.compareAndSet("owner", "job", 1, value => { value.payload.confirmedAt = 1; return value; });
  expect(repository.replaceIfVersion.mock.calls.at(-1)![0]).toMatchObject({ creditProgress: { requested: 1, moved: 0, restored: 0 } });
  expect(repository.replaceIfVersion).toHaveBeenCalledTimes(5);
});
