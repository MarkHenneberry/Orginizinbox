import { describe, expect, it, vi } from "vitest";
import { acceptPermanentDelete, advancePermanentDelete, deletionView, exactPermanentDeleteTargets, type DeleteJob, type PermanentDeleteTransport } from "@/lib/server/permanent-delete";
import type { DurableCleanupStore } from "@/lib/server/cleanup-job-store";
import { getOutlookCleanupLedgers, type OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";
import { getGmailScalableRestoreEligibility, type GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";
import { restorableGmailIndexes } from "@/lib/domain/permanent-delete";

function seed(provider: "gmail" | "microsoft" = "microsoft"): DeleteJob {
  const base = { userId: "owner", version: 1, view: { id: "job", status: "complete", expiresAt: Date.now() + 600_000 } };
  return provider === "microsoft" ? { ...base, provider, payload: { cleanupSafetyContext: { deletedItemsFolderId: "deleted-folder" },
    targets: [0, 1, 2].map(i => ({ state: "moved_verified", originalMessageId: `original-${i}`, movedMessageId: `returned-${i}`, originalFolderId: "original-folder" })) } } as OutlookCleanupStoredJob
    : { ...base, payload: { chunks: [{ index: 0, safeTargetIndexes: [0, 1, 2], verifiedMovedIndexes: [0, 1, 2], verifiedRestoredIndexes: [],
      targets: [0, 1, 2].map(i => ({ apiMessageId: `gmail-${i}` })) }] } } as unknown as GmailScalableStoredJob;
}

function memory(job = seed()) {
  let saved = structuredClone(job), lock: string | undefined;
  let failSave = false;
  const store = {
    get: async (user: string, id: string) => user === saved.userId && id === saved.view.id ? structuredClone(saved) : undefined,
    claim: async (_id: string, owner: string) => { if (lock) return; lock = owner; return structuredClone(saved); },
    releaseLock: async (_id: string, owner: string) => { if (lock === owner) lock = undefined; return true; },
    compareAndSet: async (user: string, id: string, version: number, update: (job: DeleteJob) => DeleteJob, _now?: Date, owner?: string) => {
      if (failSave || user !== saved.userId || id !== saved.view.id || version !== saved.version || (lock && owner !== lock)) return;
      saved = structuredClone({ ...update(structuredClone(saved)), version: version + 1 }); return structuredClone(saved);
    }
  } as unknown as DurableCleanupStore<DeleteJob>;
  return { store, read: () => structuredClone(saved), fail: (value: boolean) => { failSave = value; } };
}
const api = () => ({ recheck: vi.fn<PermanentDeleteTransport["recheck"]>().mockResolvedValue("eligible"), remove: vi.fn<PermanentDeleteTransport["remove"]>().mockResolvedValue(true) });

describe("exact durable permanent deletion", () => {
  it.each(["gmail", "microsoft"] as const)("deletes only frozen verified %s identities once, without changing move/restore counts", async provider => {
    const state = memory(seed(provider)), transport = api();
    await acceptPermanentDelete("owner", "job", provider, state.store);
    const before = state.read().payload;
    await advancePermanentDelete("job", state.store, async () => transport);
    expect(transport.remove).toHaveBeenCalledTimes(3);
    expect(transport.remove.mock.calls.map(([t]) => t.messageId)).toEqual([0, 1, 2].map(i => provider === "gmail" ? `gmail-${i}` : `returned-${i}`));
    expect(state.read().payload).toEqual(before);
    expect(deletionView(state.read())).toMatchObject({ status: "complete", verifiedDeleted: 3, uncertain: 0, undoRemaining: 0 });
    await acceptPermanentDelete("owner", "job", provider, state.store);
    await advancePermanentDelete("job", state.store, async () => transport);
    expect(transport.remove).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(deletionView(state.read()))).not.toMatch(/returned|gmail-|original|folder|messageId/);
  });
  it("never includes restored, uncertain, failed or merely frozen Outlook messages", () => {
    const job = seed() as OutlookCleanupStoredJob;
    job.payload.targets[0].state = "restored_verified";
    job.payload.targets[1].state = "move_uncertain";
    expect(exactPermanentDeleteTargets(job).map(t => t.messageId)).toEqual(["returned-2"]);
  });
  it("excludes Gmail restore dispatch uncertainty and restored indices", () => {
    const job = seed("gmail") as GmailScalableStoredJob;
    job.payload.chunks[0].verifiedRestoredIndexes = [0];
    expect(exactPermanentDeleteTargets(job)).toHaveLength(2);
    job.payload.chunks[0].undoMutationDispatched = true;
    expect(exactPermanentDeleteTargets(job)).toEqual([]);
  });
  it("rejects another user, wrong provider, expired and nonterminal jobs", async () => {
    const state = memory();
    await expect(acceptPermanentDelete("other", "job", "microsoft", state.store)).rejects.toThrow();
    await expect(acceptPermanentDelete("owner", "job", "gmail", state.store)).rejects.toThrow();
    const job = seed(); job.view.status = "undoing";
    expect(exactPermanentDeleteTargets(job)).toEqual([]);
    job.view.status = "complete"; job.view.expiresAt = 0;
    expect(exactPermanentDeleteTargets(job)).toEqual([]);
  });
  it("excludes relocated/missing targets and stops at uncertainty, with no substitution", async () => {
    const state = memory(), transport = api();
    transport.recheck.mockResolvedValueOnce("excluded").mockResolvedValueOnce("uncertain");
    await acceptPermanentDelete("owner", "job", "microsoft", state.store);
    await advancePermanentDelete("job", state.store, async () => transport);
    expect(transport.remove).not.toHaveBeenCalled();
    expect(transport.recheck).toHaveBeenCalledTimes(2);
    expect(deletionView(state.read())).toMatchObject({ status: "uncertain", excluded: 1, uncertain: 1, verifiedDeleted: 0, undoRemaining: 1 });
    expect(getOutlookCleanupLedgers(state.read() as OutlookCleanupStoredJob).verifiedMoved.map(t => t.movedMessageId)).toEqual(["returned-2"]);
  });
  it("persists intent before dispatch, preserves partial success and never retries ambiguous deletion", async () => {
    const state = memory(), transport = api();
    transport.remove.mockImplementation(async target => {
      expect(state.read().permanentDeletion!.targets.find(t => t.key === target.key)?.state).toBe("dispatching");
      if (target.key === "1") throw new Error("private provider body");
      return true;
    });
    await acceptPermanentDelete("owner", "job", "microsoft", state.store);
    await advancePermanentDelete("job", state.store, async () => transport);
    expect(deletionView(state.read())).toMatchObject({ status: "uncertain", verifiedDeleted: 1, uncertain: 1, undoRemaining: 1 });
    await advancePermanentDelete("job", state.store, async () => transport);
    expect(transport.remove).toHaveBeenCalledTimes(2);
  });
  it("process replacement marks unpersisted responses uncertain without a second provider request", async () => {
    const state = memory(), transport = api();
    transport.remove.mockImplementation(async () => { state.fail(true); return true; });
    await acceptPermanentDelete("owner", "job", "microsoft", state.store);
    await expect(advancePermanentDelete("job", state.store, async () => transport)).rejects.toThrow("ownership lost");
    state.fail(false);
    const factory = vi.fn(async () => transport);
    await advancePermanentDelete("job", state.store, factory);
    expect(factory).not.toHaveBeenCalled();
    expect(transport.remove).toHaveBeenCalledTimes(1);
    expect(deletionView(state.read())).toMatchObject({ verifiedDeleted: 0, uncertain: 1, undoRemaining: 2 });
  });
  it("failed dispatch persistence prevents deletion", async () => {
    const state = memory(), transport = api();
    await acceptPermanentDelete("owner", "job", "microsoft", state.store);
    state.fail(true);
    await expect(advancePermanentDelete("job", state.store, async () => transport)).rejects.toThrow();
    expect(transport.remove).not.toHaveBeenCalled();
  });
  it("simultaneous workers share one lease and cannot delete twice", async () => {
    const state = memory(), transport = api();
    await acceptPermanentDelete("owner", "job", "microsoft", state.store);
    await Promise.all([advancePermanentDelete("job", state.store, async () => transport), advancePermanentDelete("job", state.store, async () => transport)]);
    expect(transport.remove).toHaveBeenCalledTimes(3);
  });
  it("simultaneous confirmations accept one frozen ledger without replacing targets", async () => {
    const state = memory();
    const results = await Promise.allSettled([
      acceptPermanentDelete("owner", "job", "microsoft", state.store),
      acceptPermanentDelete("owner", "job", "microsoft", state.store)
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const accepted = state.read();
    expect(await acceptPermanentDelete("owner", "job", "microsoft", state.store)).toEqual(accepted);
    expect(accepted.permanentDeletion?.targets).toHaveLength(3);
  });
  it("does not reopen an expired or already-dispatched Gmail recovery after deletion", () => {
    const job = seed("gmail") as GmailScalableStoredJob;
    job.permanentDeletion = { status: "uncertain", targets: [{ key: "0:0", messageId: "gmail-0", state: "uncertain" }] };
    job.view.restoreMode = "recovery";
    expect(getGmailScalableRestoreEligibility(job).available).toBe(false);
    job.view.restoreMode = undefined; job.view.expiresAt = 0;
    expect(getGmailScalableRestoreEligibility(job).available).toBe(false);
  });
  it("Gmail recovery excludes deleted and uncertain deletion targets", async () => {
    const state = memory(seed("gmail")), transport = api();
    transport.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await acceptPermanentDelete("owner", "job", "gmail", state.store);
    await advancePermanentDelete("job", state.store, async () => transport);
    const job = state.read() as GmailScalableStoredJob;
    expect(restorableGmailIndexes(job, job.payload.chunks[0])).toEqual([2]);
    expect(getGmailScalableRestoreEligibility(job)).toMatchObject({ available: true, mode: "recovery", count: 1 });
  });
});
