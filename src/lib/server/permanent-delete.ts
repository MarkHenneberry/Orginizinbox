import "server-only";
import { randomUUID } from "node:crypto";
import { permanentDeleteView, type PermanentDeleteState } from "@/lib/domain/permanent-delete";
import { PrismaCleanupJobStore, type DurableCleanupStore } from "@/lib/server/cleanup-job-store";
import type { GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";
import type { OutlookCleanupStoredJob } from "@/lib/server/outlook-cleanup-store";

export type DeleteJob = GmailScalableStoredJob | OutlookCleanupStoredJob;
export function deletionProvider(job: DeleteJob) { return "provider" in job ? "microsoft" as const : "gmail" as const; }
const terminal = new Set(["complete", "partial", "failed", "uncertain", "undo_complete"]);

export function exactPermanentDeleteTargets(job: DeleteJob): PermanentDeleteState["targets"] {
  if (!terminal.has(job.view.status) || job.view.expiresAt <= Date.now()) return [];
  if ("provider" in job) {
    const folderId = job.payload.cleanupSafetyContext?.deletedItemsFolderId;
    if (!folderId) return [];
    return job.payload.targets.flatMap((target, index) => target.state === "moved_verified" && target.movedMessageId && target.originalFolderId
      ? [{ key: String(index), messageId: target.movedMessageId, folderId, state: "pending" as const }] : []);
  }
  return job.payload.chunks.flatMap(chunk => chunk.undoMutationDispatched ? [] : [...new Set(chunk.verifiedMovedIndexes)].flatMap(index => {
    const target = chunk.targets[index];
    return target && chunk.safeTargetIndexes.includes(index) && !chunk.verifiedRestoredIndexes.includes(index)
      ? [{ key: `${chunk.index}:${index}`, messageId: target.apiMessageId, state: "pending" as const }] : [];
  }));
}

export function deletionView(job: DeleteJob) {
  const exact = exactPermanentDeleteTargets(job);
  const state = job.permanentDeletion;
  const blocked = new Set(state?.targets.filter(t => t.state !== "pending").map(t => t.key));
  return { ...permanentDeleteView(state, exact.length),
    undoRemaining: state ? state.status === "running" ? 0 : exact.filter(t => !blocked.has(t.key)).length : undefined };
}

export async function acceptPermanentDelete(userId: string, jobId: string, provider: "gmail" | "microsoft",
  store: DurableCleanupStore<DeleteJob> = new PrismaCleanupJobStore<DeleteJob>()) {
  const job = await store.get(userId, jobId);
  if (!job || deletionProvider(job) !== provider) throw new Error("Cleanup unavailable.");
  if (job.permanentDeletion) return job;
  const owner = randomUUID();
  const locked = await store.claim(jobId, owner);
  if (!locked) throw new Error("Cleanup state changed.");
  try {
    if (locked.userId !== userId || deletionProvider(locked) !== provider) throw new Error("Cleanup unavailable.");
    if (locked.permanentDeletion) return locked;
    const targets = exactPermanentDeleteTargets(locked);
    if (!targets.length || new Set(targets.map(t => t.messageId)).size !== targets.length) throw new Error("No exact eligible targets.");
    const updated = await store.compareAndSet(userId, jobId, locked.version, current => {
      current.permanentDeletion = { status: "running", targets };
      return current;
    }, new Date(), owner);
    if (!updated) throw new Error("Cleanup state changed.");
    return updated;
  } finally { await store.releaseLock(jobId, owner); }
}

export type PermanentDeleteTransport = {
  recheck(target: PermanentDeleteState["targets"][number]): Promise<"eligible" | "excluded" | "uncertain">;
  remove(target: PermanentDeleteState["targets"][number]): Promise<boolean>;
};

// Every invocation uses the same durable job lease as cleanup and Undo.
export async function advancePermanentDelete(jobId: string, store: DurableCleanupStore<DeleteJob>,
  transport: (job: DeleteJob, owner: string) => Promise<PermanentDeleteTransport>) {
  const owner = randomUUID();
  let job = await store.claim(jobId, owner, new Date(), 10 * 60 * 1000);
  if (!job) return { outcome: "stop" as const };
  try {
    if (job.permanentDeletion?.status !== "running") return { outcome: "stop" as const };
    const save = async () => {
      const next = await store.compareAndSet(job!.userId, jobId, job!.version, () => job!, new Date(), owner);
      if (!next) throw new Error("Cleanup ownership lost.");
      job = next;
    };
    // Intent without persisted success is never repeated, even if the provider applied it.
    if (job.permanentDeletion.targets.some(t => t.state === "dispatching")) {
      for (const target of job.permanentDeletion.targets) if (target.state === "dispatching") target.state = "uncertain";
      job.permanentDeletion.status = "uncertain";
      await save();
      return { outcome: "stop" as const };
    }
    const api = await transport(job, owner);
    for (let count = 0; count < 5; count++) {
      const target = job.permanentDeletion!.targets.find(t => t.state === "pending");
      if (!target) { job.permanentDeletion!.status = "complete"; await save(); return { outcome: "stop" as const }; }
      let result: "eligible" | "excluded" | "uncertain" = "uncertain";
      try { result = await api.recheck(target); } catch { /* Fixed uncertainty only; never surface provider errors. */ }
      const key = target.key;
      if (result !== "eligible") {
        target.state = result;
        if (result === "uncertain") job.permanentDeletion!.status = "uncertain";
        await save();
        if (result === "uncertain") return { outcome: "stop" as const };
        continue;
      }
      target.state = "dispatching";
      await save();
      let confirmed = false;
      try { confirmed = await api.remove(target); } catch { /* Never retry a destructive request. */ }
      job.permanentDeletion!.targets.find(t => t.key === key)!.state = confirmed ? "verified_deleted" : "uncertain";
      if (!confirmed) job.permanentDeletion!.status = "uncertain";
      await save();
      if (!confirmed) return { outcome: "stop" as const };
    }
    return { outcome: "continue" as const };
  } finally { await store.releaseLock(jobId, owner); }
}
