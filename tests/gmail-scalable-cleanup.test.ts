import { describe, expect, it, vi } from "vitest";
import {
  assertGmailScalableDevelopmentGate,
  assertGmailScalableTransition,
  createGmailScalableChunkViews,
  formatGmailScalableDevelopmentSummary,
  getGmailScalableJobProgress,
  isGmailScalablePostStateAuditEnabled,
  shouldPollGmailScalableJob,
  simulateGmailQuotaPacing,
  simulateGmailScalableJob
} from "@/lib/domain/gmail-scalable-cleanup";
import type {
  GmailScalableCleanupProviderPort,
  GmailScalableQuotaReservation,
  GmailScalableVerificationResult
} from "@/lib/providers/gmail/scalable-cleanup-provider";
import type { GmailScalableCleanupTarget } from "@/lib/providers/gmail/scalable-targets";
import {
  CleanupJobRunner,
  GmailScalableCleanupError,
  parseScalableCount
} from "@/lib/server/gmail-scalable-cleanup-runner";
import {
  getGmailScalableRestoreEligibility,
  InMemoryGmailScalableCleanupStore,
  serializeGmailScalableJob,
  type GmailScalablePayloadCodec
} from "@/lib/server/gmail-scalable-cleanup-store";
import type { CleanupSenderGroup } from "@/lib/providers/gmail/cleanup-candidates";
import fs from "node:fs";
import path from "node:path";

const codec: GmailScalablePayloadCodec = {
  encode: (payload) => Buffer.from(JSON.stringify(payload)).toString("base64url"),
  decode: (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
};

describe("scalable Gmail cleanup state", () => {
  it("accepts explicit valid transitions and rejects inferred/invalid ones", () => {
    expect(() => assertGmailScalableTransition("created", "safety_checking")).not.toThrow();
    expect(() => assertGmailScalableTransition("chunk_complete", "undoing")).not.toThrow();
    expect(() => assertGmailScalableTransition("failed", "undoing")).not.toThrow();
    expect(() => assertGmailScalableTransition("verifying", "complete")).toThrow(/Invalid scalable cleanup transition/);
    expect(() => assertGmailScalableTransition("complete", "mutating")).toThrow(/Invalid scalable cleanup transition/);
  });

  it.each([
    [250, 1],
    [500, 2],
    [1_000, 4],
    [5_000, 20]
  ])("models %i targets as %i deterministic chunks", (targets, chunks) => {
    expect(createGmailScalableChunkViews(targets)).toHaveLength(chunks);
    expect(simulateGmailScalableJob({ targetCount: targets })).toMatchObject({
      chunkCount: chunks,
      completedChunkCount: chunks,
      verifiedCount: targets
    });
  });

  it("stops simulated progress at a partial middle chunk", () => {
    expect(simulateGmailScalableJob({ targetCount: 1_000, verifiedByChunk: [250, 249] })).toMatchObject({
      chunkCount: 4,
      completedChunkCount: 2,
      verifiedCount: 499,
      uncertainCount: 1
    });
  });

  it("aggregates a 5,000-message Undo ledger without provider work", () => {
    const restored = Array.from({ length: 20 }, () => 250);
    expect(simulateGmailScalableJob({ targetCount: 5_000, restoredByChunk: restored })).toMatchObject({
      chunkCount: 20,
      verifiedCount: 5_000,
      verifiedRestoredCount: 5_000
    });
  });

  it("models quota pause windows and rejects production/dev-gate bypasses", () => {
    expect(simulateGmailQuotaPacing({ chunkCount: 20, unitsPerChunk: 1_000 })).toEqual({
      planningWindows: 5,
      pausedDispatches: 4
    });
    expect(() => assertGmailScalableDevelopmentGate({ enabled: false, nodeEnv: "development", requestedCount: 250 })).toThrow(/disabled/);
    expect(() => assertGmailScalableDevelopmentGate({ enabled: true, nodeEnv: "production", requestedCount: 250 })).toThrow(/disabled/);
    expect(() => assertGmailScalableDevelopmentGate({ enabled: true, nodeEnv: "development", requestedCount: 250 })).not.toThrow();
    expect(() => assertGmailScalableDevelopmentGate({ enabled: true, nodeEnv: "development", requestedCount: 500 })).not.toThrow();
    expect(() => assertGmailScalableDevelopmentGate({ enabled: true, nodeEnv: "development", requestedCount: 501 })).toThrow(/250 or 500/);
    expect(() => assertGmailScalableDevelopmentGate({ enabled: true, nodeEnv: "development", requestedCount: 1_000 })).toThrow(/250 or 500/);
  });

  it("enables the post-state audit only for development scalable cleanup", () => {
    expect(isGmailScalablePostStateAuditEnabled({ auditEnabled: false, scalableCleanupEnabled: true, nodeEnv: "development" })).toBe(false);
    expect(isGmailScalablePostStateAuditEnabled({ auditEnabled: true, scalableCleanupEnabled: false, nodeEnv: "development" })).toBe(false);
    expect(isGmailScalablePostStateAuditEnabled({ auditEnabled: true, scalableCleanupEnabled: true, nodeEnv: "production" })).toBe(false);
    expect(isGmailScalablePostStateAuditEnabled({ auditEnabled: true, scalableCleanupEnabled: true, nodeEnv: "development" })).toBe(true);
  });
});

describe("transient scalable cleanup store", () => {
  it("uses versioned CAS, aggregate-only serialization, TTL, and user-scoped deletion", () => {
    const store = new InMemoryGmailScalableCleanupStore(codec);
    const runner = createHarness(store);
    const accepted = runner.runner.accept(acceptanceInput());
    const stored = store.get("user-1", accepted.id)!;
    expect(JSON.stringify(serializeGmailScalableJob(stored))).not.toMatch(/api-249|scan-1|\"uid\":250|\"uidValidity\":\"77\"/);
    expect(store.compareAndSet("user-1", accepted.id, stored.version - 1, (job) => job)).toBeUndefined();
    expect(store.compareAndSet("user-1", accepted.id, stored.version, (job) => job)?.version).toBe(stored.version + 1);
    expect(store.deleteForUser("user-1")).toBe(1);
    expect(store.get("user-1", accepted.id)).toBeUndefined();
  });

  it("purges expired encrypted payloads", () => {
    const store = new InMemoryGmailScalableCleanupStore(codec);
    const harness = createHarness(store);
    const accepted = harness.runner.accept(acceptanceInput());
    const stored = store.get("user-1", accepted.id)!;
    store.compareAndSet("user-1", accepted.id, stored.version, (job) => {
      job.view.expiresAt = Date.now() - 1;
      return job;
    });
    expect(store.get("user-1", accepted.id)).toBeUndefined();
  });
});

describe("CleanupJobRunner", () => {
  it("runs one deterministic 250-message chunk and one bulk Undo single-flight", async () => {
    const harness = createHarness();
    const first = harness.runner.accept(acceptanceInput());
    const duplicate = harness.runner.accept(acceptanceInput());
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.duplicateStartCount).toBe(1);
    expect(harness.queue).toHaveLength(1);

    await harness.flushOne();
    expect(harness.runner.getStatus("user-1", first.id)).toMatchObject({ status: "ready", safeCount: 250 });

    harness.runner.confirm("user-1", first.id);
    harness.runner.confirm("user-1", first.id);
    expect(harness.queue).toHaveLength(1);
    await harness.flushOne();
    expect(harness.provider.batchTrashCalls).toBe(1);
    expect(harness.runner.getStatus("user-1", first.id).status).toBe("verifying");
    await harness.flushOne();

    const complete = harness.runner.getStatus("user-1", first.id);
    expect(complete).toMatchObject({
      status: "complete",
      attemptedCount: 250,
      verifiedCount: 250,
      failedCount: 0,
      uncertainCount: 0,
      undoAvailable: true,
      duplicateDispatchCount: 1
    });
    expect(complete.progressLabel).toBe("250 checked; 250 moved to Trash.");
    expect(complete.postStateAudit).toBeUndefined();
    expect(complete.developmentAuditQuotaUnits).toBe(0);
    expect(harness.provider.auditCalls).toBe(0);
    expect(complete.suggestedDeltas).toEqual([
      { groupIndex: 0, verifiedMovedCount: 250, verifiedRestoredCount: 0 }
    ]);

    harness.runner.undo("user-1", first.id);
    harness.runner.undo("user-1", first.id);
    expect(harness.queue).toHaveLength(1);
    await harness.flushOne();

    const undone = harness.runner.getStatus("user-1", first.id);
    expect(undone).toMatchObject({
      status: "undo_complete",
      verifiedRestoredCount: 250,
      failedRestoreCount: 0,
      uncertainRestoreCount: 0,
      duplicateUndoCount: 1
    });
    expect(undone.suggestedDeltas).toEqual([
      { groupIndex: 0, verifiedMovedCount: 250, verifiedRestoredCount: 250 }
    ]);
    expect(harness.provider.batchUndoCalls).toBe(1);
  });

  it("runs a deterministic safety-reduced 500-message cleanup and Undo as two durable logical chunks", async () => {
    const store = new InMemoryGmailScalableCleanupStore(codec);
    const harness = createHarness(store);
    harness.provider.safeTargetCounts = [231, 235];
    harness.provider.personalExcludedCounts = [19, 15];
    const input = {
      ...acceptanceInput(),
      requestedCount: 500,
      groups: [group(0, 600)],
      targets: Array.from({ length: 600 }, (_, index) => target(index))
    };
    const accepted = harness.runner.accept(input);
    const stored = store.get("user-1", accepted.id)!;
    expect(stored.payload.chunks).toHaveLength(2);
    expect(stored.payload.chunks[0].targets.map((candidate) => candidate.apiMessageId)).toEqual(
      Array.from({ length: 250 }, (_, index) => `api-${index}`)
    );
    expect(stored.payload.chunks[1].targets.map((candidate) => candidate.apiMessageId)).toEqual(
      Array.from({ length: 250 }, (_, index) => `api-${index + 250}`)
    );
    expect(JSON.stringify(stored.payload.chunks)).not.toContain("api-500");

    await harness.flushOne();
    expect(harness.runner.getStatus("user-1", accepted.id)).toMatchObject({ status: "ready", safeCount: 231 });
    harness.runner.confirm("user-1", accepted.id);
    await harness.flushOne();
    await harness.flushOne();

    const chunkOne = harness.runner.getStatus("user-1", accepted.id);
    expect(chunkOne).toMatchObject({ status: "chunk_complete", verifiedCount: 231, excludedCount: 19 });
    expect(chunkOne.chunks[0]).toMatchObject({ targetCount: 250, excludedCount: 19, attemptedCount: 231, verifiedCount: 231 });
    expect(getGmailScalableJobProgress(chunkOne)).toMatchObject({
      chunksComplete: 1,
      jobTerminal: false,
      nextChunk: 2,
      workflowContinuationExpected: true
    });
    expect(shouldPollGmailScalableJob(chunkOne)).toBe(true);
    const checkpointState = store.get("user-1", accepted.id)!;
    expect(getGmailScalableRestoreEligibility(checkpointState)).toMatchObject({
      available: true,
      mode: "recovery",
      count: 231
    });
    for (const status of ["paused", "partial", "failed"] as const) {
      const interrupted = structuredClone(checkpointState);
      interrupted.view.status = status;
      expect(getGmailScalableRestoreEligibility(interrupted)).toMatchObject({
        available: true,
        mode: "recovery",
        count: 231
      });
    }

    await harness.flushOne();
    expect(harness.runner.getStatus("user-1", accepted.id)).toMatchObject({ status: "mutating", safeCount: 466, excludedCount: 34 });
    await harness.flushOne();
    await harness.flushOne();

    const complete = harness.runner.getStatus("user-1", accepted.id);
    expect(complete).toMatchObject({
      status: "complete",
      requestedCount: 500,
      safeCount: 466,
      excludedCount: 34,
      attemptedCount: 466,
      verifiedCount: 466,
      failedCount: 0,
      uncertainCount: 0,
      verifiedProcessedCount: 466,
      undoAvailable: true
    });
    expect(complete.chunks[1]).toMatchObject({ targetCount: 250, excludedCount: 15, attemptedCount: 235, verifiedCount: 235 });
    expect(shouldPollGmailScalableJob(complete)).toBe(false);
    expect(getGmailScalableRestoreEligibility(store.get("user-1", accepted.id)!)).toMatchObject({
      available: true,
      mode: "undo",
      count: 466
    });
    expect(harness.provider.trashBatches).toEqual([
      Array.from({ length: 231 }, (_, index) => `api-${index}`),
      Array.from({ length: 235 }, (_, index) => `api-${index + 250}`)
    ]);
    expect(harness.provider.batchTrashCalls).toBe(2);
    expect(harness.provider.trashBatches.flat()).not.toContain("api-231");
    expect(harness.provider.trashBatches.flat()).not.toContain("api-485");

    const summary = formatGmailScalableDevelopmentSummary(complete);
    expect(summary).toContain("Requested: 500");
    expect(summary).toContain("Chunks: 2");
    expect(summary).toContain("Chunks complete: 2 / 2");
    expect(summary).toContain("Chunk 1\nChecked: 250\nSafety excluded: 19\nApproved: 231");
    expect(summary).toContain("Chunk 2\nChecked: 250\nSafety excluded: 15\nApproved: 235");
    expect(summary).toContain("Approved messages processed: 466 / 466");
    expect(summary).toContain("Present while Undo available: yes");
    expect(summary).toContain("Deleted after terminal Undo: required");

    harness.runner.undo("user-1", accepted.id);
    await harness.flushOne();
    expect(harness.runner.getStatus("user-1", accepted.id)).toMatchObject({ status: "undoing", verifiedRestoredCount: 231 });
    harness.runner.undo("user-1", accepted.id);
    expect(harness.queue).toHaveLength(1);
    await harness.flushOne();

    const undone = harness.runner.getStatus("user-1", accepted.id);
    expect(undone).toMatchObject({ status: "undo_complete", verifiedRestoredCount: 466, failedRestoreCount: 0, uncertainRestoreCount: 0 });
    expect(harness.provider.undoBatches).toEqual(harness.provider.trashBatches);
    expect(harness.provider.batchUndoCalls).toBe(2);
    expect(formatGmailScalableDevelopmentSummary(undone)).toContain("Undo chunks: 2");
  });

  it("rejects 251 and does not silently refill excluded targets", async () => {
    const harness = createHarness();
    expect(() => harness.runner.accept({ ...acceptanceInput(), requestedCount: 251 })).toThrow(GmailScalableCleanupError);
    harness.provider.safeTargetCount = 247;
    const accepted = harness.runner.accept(acceptanceInput());
    await harness.flushOne();
    expect(harness.runner.getStatus("user-1", accepted.id)).toMatchObject({
      status: "ready",
      requestedCount: 250,
      safeCount: 247,
      excludedCount: 3
    });
  });

  it("completes a safety-reduced job and bulk-undoes only its exact verified-moved ledger", async () => {
    const harness = createHarness();
    harness.provider.safeTargetCount = 231;
    harness.provider.personalExcludedCount = 19;
    const accepted = harness.runner.accept(acceptanceInput());

    await harness.flushOne();
    expect(harness.runner.getStatus("user-1", accepted.id)).toMatchObject({
      status: "ready",
      requestedCount: 250,
      safeCount: 231,
      excludedCount: 19
    });

    harness.runner.confirm("user-1", accepted.id);
    await harness.flushOne();
    await harness.flushOne();
    const complete = harness.runner.getStatus("user-1", accepted.id);
    expect(complete).toMatchObject({
      status: "complete",
      requestedCount: 250,
      excludedCount: 19,
      attemptedCount: 231,
      verifiedCount: 231,
      failedCount: 0,
      uncertainCount: 0,
      verifiedProcessedCount: 231,
      undoAvailable: true
    });
    expect(complete.progressLabel).toBe("250 checked; 231 moved to Trash.");
    expect(complete.suggestedDeltas).toEqual([
      { groupIndex: 0, verifiedMovedCount: 231, verifiedRestoredCount: 0 }
    ]);
    expect(harness.provider.trashTargetIds).toEqual(Array.from({ length: 231 }, (_, index) => `api-${index}`));
    expect(harness.provider.trashTargetIds).not.toContain("api-231");
    expect(harness.provider.trashTargetIds).not.toContain("api-250");

    const summary = formatGmailScalableDevelopmentSummary(complete);
    expect(summary).toContain("Excluded before mutation: 19");
    expect(summary).toContain("Final approved: 231");
    expect(summary).toContain("Requested = Safety excluded + Attempted: PASS");
    expect(summary).toContain("Attempted = Verified + Failed + Uncertain: PASS");
    expect(summary).toContain("Verified: 231");
    expect(summary).toContain("Approved messages processed: 231 / 231");
    expect(summary).toContain("Job result: COMPLETE");
    expect(summary).toContain("Eligible: yes");
    expect(summary).toContain("Targets: 231");

    harness.runner.undo("user-1", accepted.id);
    await harness.flushOne();
    const undone = harness.runner.getStatus("user-1", accepted.id);
    expect(undone).toMatchObject({
      status: "undo_complete",
      verifiedRestoredCount: 231,
      failedRestoreCount: 0,
      uncertainRestoreCount: 0
    });
    expect(undone.suggestedDeltas).toEqual([
      { groupIndex: 0, verifiedMovedCount: 231, verifiedRestoredCount: 231 }
    ]);
    expect(harness.provider.undoTargetIds).toEqual(harness.provider.trashTargetIds);
  });

  it("does not give full-success completion or Undo to a safety-reduced uncertain mutation", async () => {
    const store = new InMemoryGmailScalableCleanupStore(codec);
    const harness = createHarness(store);
    harness.provider.safeTargetCount = 231;
    harness.provider.personalExcludedCount = 19;
    harness.provider.trashUncertainCount = 1;
    const accepted = harness.runner.accept(acceptanceInput());

    await harness.flushOne();
    harness.runner.confirm("user-1", accepted.id);
    await harness.flushOne();
    await harness.flushOne();

    expect(harness.runner.getStatus("user-1", accepted.id)).toMatchObject({
      status: "uncertain",
      requestedCount: 250,
      excludedCount: 19,
      attemptedCount: 231,
      verifiedCount: 230,
      failedCount: 0,
      uncertainCount: 1,
      undoAvailable: false
    });
    expect(getGmailScalableRestoreEligibility(
      store.get("user-1", accepted.id)!
    )).toMatchObject({ available: true, mode: "recovery", count: 230 });
    expect(() => harness.runner.undo("user-1", accepted.id)).toThrow(/every attempted message/);
    expect(harness.provider.batchUndoCalls).toBe(0);
  });

  it("completes without mutation or Undo when the final safety check excludes every target", async () => {
    const harness = createHarness();
    harness.provider.safeTargetCount = 0;
    harness.provider.personalExcludedCount = 250;
    const accepted = harness.runner.accept(acceptanceInput());

    await harness.flushOne();
    expect(harness.runner.getStatus("user-1", accepted.id)).toMatchObject({
      status: "complete",
      requestedCount: 250,
      safeCount: 0,
      excludedCount: 250,
      attemptedCount: 0,
      verifiedCount: 0,
      undoAvailable: false
    });
    expect(harness.queue).toHaveLength(0);
    expect(harness.provider.batchTrashCalls).toBe(0);
    expect(harness.provider.batchUndoCalls).toBe(0);
    expect(() => harness.runner.undo("user-1", accepted.id)).toThrow(/every attempted message/);
  });

  it("audits 231 exact Trash messages across 230 threads without changing message accounting, then audits Undo", async () => {
    const harness = createHarness(new InMemoryGmailScalableCleanupStore(codec), true);
    harness.provider.safeTargetCount = 231;
    harness.provider.personalExcludedCount = 19;
    harness.provider.auditResults.push(
      { foundCount: 231, distinctThreadCount: 230 },
      { foundCount: 1, distinctThreadCount: 1 }
    );
    const accepted = harness.runner.accept(acceptanceInput());

    await harness.flushOne();
    harness.runner.confirm("user-1", accepted.id);
    await harness.flushOne();
    await harness.flushOne();

    const complete = harness.runner.getStatus("user-1", accepted.id);
    expect(complete).toMatchObject({
      status: "complete",
      attemptedCount: 231,
      verifiedCount: 231,
      undoAvailable: true,
      quotaConsumedUnits: 58,
      developmentAuditQuotaUnits: 5,
      suggestedDeltas: [{ groupIndex: 0, verifiedMovedCount: 231, verifiedRestoredCount: 0 }],
      postStateAudit: {
        cleanup: {
          state: "complete",
          targetCount: 231,
          authoritativeHistoryVerifiedCount: 231,
          exactTargetMessagesFoundInTrash: 231,
          exactTargetMessagesAbsentFromTrash: 0,
          distinctGmailThreadCount: 230,
          trashListRequests: 1,
          trashListPages: 1,
          mismatchCount: 0
        }
      }
    });
    expect(harness.provider.auditTargetIds[0]).toEqual(harness.provider.trashTargetIds);
    expect(JSON.stringify(complete)).not.toMatch(/api-0|thread-0|"uidValidity":|"historyCheckpoint":/);
    const summary = formatGmailScalableDevelopmentSummary(complete);
    expect(summary).toContain("Exact target messages found in Trash: 231");
    expect(summary).toContain("Distinct Gmail threads for target messages: 230");
    expect(summary).toContain("History vs Trash-state mismatch: 0");
    expect(summary).toContain("Authoritative cleanup units: 58");
    expect(summary).toContain("Development audit units: 5");

    harness.runner.undo("user-1", accepted.id);
    await harness.flushOne();
    const undone = harness.runner.getStatus("user-1", accepted.id);
    expect(undone).toMatchObject({
      status: "undo_complete",
      verifiedRestoredCount: 231,
      developmentAuditQuotaUnits: 10,
      suggestedDeltas: [{ groupIndex: 0, verifiedMovedCount: 231, verifiedRestoredCount: 231 }],
      postStateAudit: {
        undo: {
          targetCount: 231,
          exactTargetMessagesFoundInTrash: 1,
          exactTargetMessagesAbsentFromTrash: 230,
          mismatchCount: 1
        }
      }
    });
    expect(harness.provider.auditTargetIds[1]).toEqual(harness.provider.undoTargetIds);
  });

  it("reports a cleanup post-state mismatch without changing completion or Suggested deltas", async () => {
    const harness = createHarness(new InMemoryGmailScalableCleanupStore(codec), true);
    harness.provider.safeTargetCount = 231;
    harness.provider.personalExcludedCount = 19;
    harness.provider.auditResults.push({ foundCount: 230, distinctThreadCount: 230 });
    const accepted = harness.runner.accept(acceptanceInput());

    await harness.flushOne();
    harness.runner.confirm("user-1", accepted.id);
    await harness.flushOne();
    await harness.flushOne();

    expect(harness.runner.getStatus("user-1", accepted.id)).toMatchObject({
      status: "complete",
      verifiedCount: 231,
      undoAvailable: true,
      suggestedDeltas: [{ groupIndex: 0, verifiedMovedCount: 231, verifiedRestoredCount: 0 }],
      postStateAudit: {
        cleanup: {
          exactTargetMessagesFoundInTrash: 230,
          exactTargetMessagesAbsentFromTrash: 1,
          mismatchCount: 1
        }
      }
    });
  });

  it("pauses before exceeding 4,500 units and resumes through scheduling", async () => {
    const harness = createHarness();
    harness.provider.exhaustQuotaOnFirstSafety = true;
    const accepted = harness.runner.accept(acceptanceInput());
    await harness.flushOne();
    expect(harness.runner.getStatus("user-1", accepted.id)).toMatchObject({
      status: "paused",
      quotaConsumedUnits: 4_500
    });
    expect(harness.queue).toHaveLength(1);
    harness.now += 60_000;
    await harness.flushOne();
    await harness.flushOne();
    expect(harness.runner.getStatus("user-1", accepted.id).status).toBe("ready");
  });

  it("formats aggregate-only diagnostics", async () => {
    const harness = createHarness();
    const accepted = harness.runner.accept(acceptanceInput());
    await harness.flushOne();
    const summary = formatGmailScalableDevelopmentSummary(harness.runner.getStatus("user-1", accepted.id));
    expect(summary).toContain("ORGANIZINBOX DEV SCALABLE CLEANUP SUMMARY");
    expect(summary).toContain("Requested: 250");
    expect(summary).not.toMatch(/api-249|uid-249|historyId=|Bearer |example subject/i);
  });
});

describe("scalable route and UI boundaries", () => {
  it("exposes only 250 and 500 through the development scalable gate", () => {
    expect(parseScalableCount(250)).toBe(250);
    expect(parseScalableCount(500)).toBe(500);
    expect(() => parseScalableCount(501)).toThrow(/250 or 500/);
    expect(() => parseScalableCount(1_000)).toThrow(/250 or 500/);

    const root = process.cwd();
    const page = fs.readFileSync(path.join(root, "app/app/cleanup/page.tsx"), "utf8");
    const config = fs.readFileSync(path.join(root, "src/lib/config.ts"), "utf8");
    const runner = fs.readFileSync(path.join(root, "src/lib/server/gmail-scalable-cleanup-runner.ts"), "utf8");
    const liveWorkflow = fs.readFileSync(path.join(root, "src/lib/server/gmail-scalable-live-workflow.ts"), "utf8");
    expect(page).toContain("gmailScalableCleanupDevCounts");
    expect(config).toContain("GMAIL_CLEANUP_MAX_MESSAGES: z.coerce.number().int().min(1).max(100)");
    expect(runner).toContain('import("@/lib/server/gmail-scalable-live-workflow")');
    expect(liveWorkflow).toContain("createPrismaGmailScalableCleanupStore");
    expect(liveWorkflow).toContain("startGmailScalableCleanupWorkflow");
    expect(liveWorkflow).toContain("startGmailScalableUndoWorkflow");
  });

  it("keeps status polling aggregate-only and provider work in the scheduled runner", () => {
    const root = process.cwd();
    const statusRoute = fs.readFileSync(path.join(root, "app/api/dev/gmail-scalable-cleanup/status/route.ts"), "utf8");
    const client = fs.readFileSync(path.join(root, "src/components/product/GmailCleanupClient.tsx"), "utf8");
    const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
    expect(statusRoute).not.toMatch(/batchModify|history\.list|ImapFlow|moveToTrash|removeTrashLabel/);
    expect(client).toMatch(/gmail-scalable-cleanup\/status/);
    expect(client).toContain("shouldPollGmailScalableJob(scalableJob)");
    expect(client).toContain('status === "chunk_complete"');
    expect(client).toContain("messages moved so far");
    expect(client).toContain("!progress.jobTerminal");
    expect(client).toMatch(/ScalableCleanupWorkspace[\s\S]+OperationStatus[\s\S]+FrozenSenderContext/);
    expect(schema).not.toMatch(/GmailId|ImapUid|UidValidity|HistoryCursor|Subject|Header/);
  });

  it("renders approved mutation progress and keeps scalable Undo independent from legacy proof flags", () => {
    const root = process.cwd();
    const client = fs.readFileSync(path.join(root, "src/components/product/GmailCleanupClient.tsx"), "utf8");
    const runner = fs.readFileSync(path.join(root, "src/lib/server/gmail-scalable-cleanup-runner.ts"), "utf8");
    const undoRoute = fs.readFileSync(path.join(root, "app/api/dev/gmail-scalable-cleanup/undo/route.ts"), "utf8");
    expect(client).toMatch(/Approved messages moved[\s\S]+verifiedProcessedCount\.toLocaleString\(\)[\s\S]+attemptedCount\.toLocaleString\(\)/);
    expect(client).toMatch(/max=\{job\.attemptedCount\}/);
    expect(client).toMatch(/Messages checked[\s\S]+Left alone after the final safety check/);
    expect(client).toMatch(/Messages checked[\s\S]+Currently approved[\s\S]+Currently left alone/);
    expect(client).toMatch(/Move up to \{job\.safeCount\.toLocaleString\(\)\} to Trash/);
    expect(client).toMatch(/Undo \{job\.verifiedCount\.toLocaleString\(\)\} messages/);
    expect(client).not.toMatch(/verifiedProcessedCount\.toLocaleString\(\)[\s\S]{0,80}requestedCount\.toLocaleString\(\)/);
    expect(`${runner}\n${undoRoute}`).not.toMatch(/gmailBulkUndoProofEnabled|gmailBulkUndoHistoryShadowEnabled/);
  });

  it("keeps the post-state audit false by default and exposes aggregate diagnostic copy only", () => {
    const root = process.cwd();
    const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    const client = fs.readFileSync(path.join(root, "src/components/product/GmailCleanupClient.tsx"), "utf8");
    expect(envExample).toContain('GMAIL_SCALABLE_POSTSTATE_AUDIT_ENABLED="false"');
    expect(client).toContain("Development post-state audit");
    expect(client).not.toMatch(/postStateAudit[\s\S]{0,200}(messageId|threadId|apiMessageId)/);
    expect(client).toContain("copiedDiagnosticKey === diagnostic.key");
    expect(client).toContain("navigator.clipboard.writeText(diagnostic.content)");
    expect(client).toContain("), 2_000);");
    expect(client).toContain("copiedDiagnosticKey === diagnostic.key ? \"Copied\"");
  });
});

class FakeProvider implements GmailScalableCleanupProviderPort {
  safeTargetCount = 250;
  safeTargetCounts: number[] = [];
  personalExcludedCount = 0;
  personalExcludedCounts: number[] = [];
  trashUncertainCount = 0;
  batchTrashCalls = 0;
  batchUndoCalls = 0;
  trashTargetIds: string[] = [];
  trashBatches: string[][] = [];
  undoTargetIds: string[] = [];
  undoBatches: string[][] = [];
  auditCalls = 0;
  auditTargetIds: string[][] = [];
  auditResults: Array<{ foundCount: number; distinctThreadCount: number }> = [];
  safetyCalls = 0;
  exhaustQuotaOnFirstSafety = false;

  async runSafetyCheck(input: { targets: readonly GmailScalableCleanupTarget[]; reserve: GmailScalableQuotaReservation }) {
    this.safetyCalls += 1;
    if (this.exhaustQuotaOnFirstSafety && this.safetyCalls === 1) {
      for (let index = 0; index < 91; index += 1) await input.reserve("batchModify");
    } else {
      await input.reserve("messagesList");
    }
    const safeTargetCount = this.safeTargetCounts[this.safetyCalls - 1] ?? this.safeTargetCount;
    const personalExcludedCount = this.personalExcludedCounts[this.safetyCalls - 1] ?? this.personalExcludedCount;
    const safeTargets = input.targets.slice(0, safeTargetCount);
    return {
      safeTargets,
      missingCount: input.targets.length - safeTargets.length - personalExcludedCount,
      identityMismatchCount: 0,
      starredCount: 0,
      importantCount: 0,
      trashCount: 0,
      sentCount: 0,
      draftCount: 0,
      personalCount: personalExcludedCount,
      personalListRequests: 1,
      retryCount: 0,
      imapMs: 10,
      personalMs: 5
    };
  }

  async captureHistoryCheckpoint(reserve: GmailScalableQuotaReservation) {
    await reserve("getProfile");
    return "123";
  }

  async moveToTrash(ids: readonly string[], reserve: GmailScalableQuotaReservation) {
    await reserve("batchModify");
    this.batchTrashCalls += 1;
    this.trashTargetIds = [...ids];
    this.trashBatches.push([...ids]);
  }

  async verifyTrash(input: { targetIds: readonly string[]; reserve: GmailScalableQuotaReservation }) {
    await input.reserve("historyList");
    const verifiedCount = input.targetIds.length - this.trashUncertainCount;
    return verification(input.targetIds.slice(0, verifiedCount), [], input.targetIds.slice(verifiedCount));
  }

  async removeTrashLabel(ids: readonly string[], reserve: GmailScalableQuotaReservation) {
    await reserve("batchModify");
    this.batchUndoCalls += 1;
    this.undoTargetIds = [...ids];
    this.undoBatches.push([...ids]);
  }

  async verifyTrashRemoval(input: { targetIds: readonly string[]; reserve: GmailScalableQuotaReservation }) {
    await input.reserve("historyList");
    return verified(input.targetIds);
  }

  async auditTrashPostState(input: { targetIds: readonly string[]; reserve: GmailScalableQuotaReservation }) {
    await input.reserve("messagesList");
    this.auditCalls += 1;
    this.auditTargetIds.push([...input.targetIds]);
    const configured = this.auditResults.shift();
    const foundCount = configured?.foundCount ?? input.targetIds.length;
    return {
      exactTargetMessagesFoundInTrash: foundCount,
      exactTargetMessagesAbsentFromTrash: input.targetIds.length - foundCount,
      distinctGmailThreadCount: configured?.distinctThreadCount ?? foundCount,
      trashListRequests: 1,
      trashListPages: 1
    };
  }
}

function createHarness(store = new InMemoryGmailScalableCleanupStore(codec), postStateAuditEnabled = false) {
  const provider = new FakeProvider();
  const queue: Array<() => Promise<void>> = [];
  const harness = {
    now: Date.now(),
    provider,
    queue,
    runner: undefined as unknown as CleanupJobRunner,
    async flushOne() {
      const work = queue.shift();
      if (!work) throw new Error("No scheduled runner work.");
      await work();
    }
  };
  harness.runner = new CleanupJobRunner({
    store,
    providerForUser: async () => provider,
    validateContext: vi.fn(),
    onMutationAttempted: vi.fn(),
    now: () => harness.now,
    schedule: (work) => queue.push(work),
    acceptanceHash: (value) => `hash:${value}`,
    postStateAuditEnabled
  });
  return harness;
}

function acceptanceInput() {
  return {
    userId: "user-1",
    scanId: "scan-1",
    uidValidity: "77",
    requestedCount: 250,
    groupIndices: [0],
    groups: [group(0, 300)],
    targets: Array.from({ length: 300 }, (_, index) => target(index))
  };
}

function group(index: number, cleanupCandidateCount: number): CleanupSenderGroup {
  return {
    index,
    displayName: "Sender",
    secondaryLabel: "example.com",
    searchableIdentity: "example.com",
    totalMessages: cleanupCandidateCount,
    unreadMessages: cleanupCandidateCount,
    oldMessages: cleanupCandidateCount,
    oldestMessageAt: new Date(0),
    estimatedEligibleBytes: 0,
    protectedMessages: 0,
    reviewMessages: 0,
    cleanupCandidateCount,
    cleanupConfidence: "very_high",
    eligible: true
  };
}

function target(index: number): GmailScalableCleanupTarget {
  return {
    uid: index + 1,
    apiMessageId: `api-${index}`,
    groupIndex: 0,
    immutableEvidence: {
      eligibleAtScan: true,
      subjectProtected: false,
      participatedConversation: false,
      protectedAtScan: false,
      ageBand: "very_old",
      cleanupSignals: ["HAS_LIST_ID"]
    }
  };
}

function verified(ids: readonly string[]): GmailScalableVerificationResult {
  return verification(ids, [], []);
}

function verification(
  verifiedIds: readonly string[],
  failedIds: readonly string[],
  uncertainIds: readonly string[]
): GmailScalableVerificationResult {
  return {
    verifiedIds: [...verifiedIds],
    failedIds: [...failedIds],
    uncertainIds: [...uncertainIds],
    historyVerifiedCount: verifiedIds.length,
    listVerifiedCount: 0,
    getVerifiedCount: 0,
    historyRequests: 1,
    historyPages: 1,
    historyPollAttempts: 1,
    listRequests: 1,
    listPages: 1,
    getFallbackRequests: 0,
    retryCount: 0,
    historyUnavailable: false,
    durationMs: 5
  };
}
