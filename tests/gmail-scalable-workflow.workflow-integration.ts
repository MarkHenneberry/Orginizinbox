import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitForSleep } from "@workflow/vitest";
import { start } from "workflow/api";
import {
  getGmailScalableJobProgress,
  shouldPollGmailScalableJob
} from "@/lib/domain/gmail-scalable-cleanup";
import { markGmailScalableMutationDispatch, planGmailScalableWorkflowStep } from "@/lib/domain/gmail-scalable-workflow";
import { prisma } from "@/lib/server/db";
import { clearGmailCleanupStateAfterDisconnect } from "@/lib/server/disconnect";
import {
  createPrismaGmailScalableCleanupStore,
  type GmailScalableDurableCleanupStore
} from "@/lib/server/gmail-scalable-cleanup-durable-store";
import { serializeGmailScalableJob, type GmailScalableStoredJob } from "@/lib/server/gmail-scalable-cleanup-store";
import { getDurableGmailScalableCleanupStatus } from "@/lib/server/gmail-scalable-live-workflow";
import {
  GmailScalableWorkflowCoordinator,
  createGmailScalableWorkflowCoordinator
} from "@/lib/server/gmail-scalable-workflow-coordinator";
import { GmailScalableProviderWorkflowExecutor } from "@/lib/server/gmail-scalable-workflow-executor";
import { GmailScalableFixtureMutationInterruptedError } from "@/lib/server/gmail-scalable-workflow-fixture-provider";
import {
  assertFixtureHarnessEnabled,
  confirmGmailScalableWorkflowFixture,
  createGmailScalableWorkflowFixture,
  deleteGmailScalableWorkflowFixture,
  getGmailScalableWorkflowFixtureAggregate,
  prepareGmailScalableWorkflowFixtureUndo,
  type GmailScalableWorkflowFixtureIds,
  type GmailScalableWorkflowFixtureOptions
} from "@/lib/server/gmail-scalable-workflow-fixture";
import {
  gmailScalableCleanupWorkflow,
  gmailScalableUndoWorkflow
} from "@/workflows/gmail-scalable-cleanup";

const fixtureUsers = new Set<string>();
let googleProviderRequestCount = 0;
let originalFetch: typeof globalThis.fetch;

beforeAll(async () => {
  assertFixtureHarnessEnabled();
  await prisma.user.deleteMany({ where: { id: { startsWith: "fixture-user-" } } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (/\b(?:googleapis\.com|google\.com)\b/i.test(url)) {
      googleProviderRequestCount += 1;
      throw new Error("A Workflow fixture attempted a Google provider request.");
    }
    return originalFetch(input, init);
  };
});

afterEach(async () => {
  expect(googleProviderRequestCount).toBe(0);
  for (const userId of fixtureUsers) await deleteGmailScalableWorkflowFixture(userId);
  fixtureUsers.clear();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await prisma.user.deleteMany({ where: { id: { startsWith: "fixture-user-" } } });
  await prisma.$disconnect();
});

describe.sequential("durable Prisma and Workflow fixture architecture", () => {
  it("runs a 500-message Workflow and persists only encrypted sensitive state", async () => {
    const fixture = await createFixture({ requestedCount: 500 });
    const initialRow = await prisma.cleanupJobState.findUnique({
      where: { jobId: fixture.jobId },
      select: {
        jobId: true,
        userId: true,
        encryptedPayload: true,
        version: true,
        lockOwner: true,
        lockExpiresAt: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true
      }
    });
    expect(initialRow).not.toBeNull();
    expect(initialRow?.encryptedPayload).not.toContain(fixture.firstFixtureMessageId);
    expect(Object.keys(initialRow ?? {}).sort()).toEqual([
      "createdAt",
      "encryptedPayload",
      "expiresAt",
      "jobId",
      "lockExpiresAt",
      "lockOwner",
      "updatedAt",
      "userId",
      "version"
    ]);

    const run = await start(gmailScalableCleanupWorkflow, [fixture.jobId]);
    const result = await run.returnValue;
    expect(result).toMatchObject({ outcome: "stop", reason: "complete", status: "complete", verifiedCount: 500 });

    const state = await getState(fixture);
    expect(state.view.chunkSize).toBe(250);
    expect(state.view.chunkCount).toBe(2);
    expect(state.view.verifiedCount).toBe(500);
    expect(control(state).verifiedProgress).toEqual([250, 500]);
    expect(dispatchCounts(state, "dispatch_trash")).toEqual([1, 1]);
    expect(state.view.quotaConsumedUnits).toBe(126);
    expect(state.view.chunks.map((chunk) => chunk.quotaUnits)).toEqual([63, 63]);
    expect(state.view.chunks.map((chunk) => chunk.batchModifyRequests)).toEqual([1, 1]);
    expect(state.view.suggestedDeltas).toEqual([{ groupIndex: 0, verifiedMovedCount: 500, verifiedRestoredCount: 0 }]);
    expect(await getGmailScalableWorkflowFixtureAggregate(fixture.jobId)).toMatchObject({ status: "completed" });

    const browserStatus = JSON.stringify(serializeGmailScalableJob(state));
    expect(browserStatus).not.toContain(fixture.firstFixtureMessageId);
    expect(browserStatus).not.toContain(state.payload.uidValidity);
    expect(browserStatus).not.toContain("encryptedPayload");
    expect(browserStatus).not.toContain("historyCheckpoint");
    expect(browserStatus).not.toContain("safeTargetIndexes");
  });

  it("preflights an entire 250-message job without mutation and reruns stricter final safety", async () => {
    const fixture = await createFixture({
      requestedCount: 250,
      autoConfirm: false,
      preflightSafetyExcludedCountsByChunk: [4],
      safetyExcludedCountsByChunk: [7]
    });
    const coordinator = createGmailScalableWorkflowCoordinator();
    expect(await coordinator.advance(fixture.jobId, "cleanup")).toMatchObject({ operation: "preflight_safety" });
    const ready = await getState(fixture);
    expect(ready.view).toMatchObject({ status: "ready", requestedCount: 250, safeCount: 246, excludedCount: 4 });
    expect(ready.payload.chunks[0].safeTargetIndexes).toHaveLength(0);
    expect(dispatchCounts(ready, "dispatch_trash")).toEqual([0]);

    await confirmGmailScalableWorkflowFixture(fixture.userId, fixture.jobId);
    const run = await start(gmailScalableCleanupWorkflow, [fixture.jobId]);
    expect(await run.returnValue).toMatchObject({ status: "complete", verifiedCount: 243 });
    const complete = await getState(fixture);
    expect(complete.view).toMatchObject({
      requestedCount: 250,
      safeCount: 243,
      excludedCount: 7,
      attemptedCount: 243,
      verifiedCount: 243
    });
    expect(control(complete).operationLedger.filter((entry) => entry.operation === "preflight_safety")).toHaveLength(1);
    expect(control(complete).operationLedger.filter((entry) => entry.operation === "safety")).toHaveLength(1);
    expect(dispatchCounts(complete, "dispatch_trash")).toEqual([1]);
  });

  it("continues the live failure shape from a nonterminal chunk checkpoint to COMPLETE", async () => {
    const fixture = await createFixture({
      requestedCount: 500,
      autoConfirm: false,
      preflightSafetyExcludedCountsByChunk: [10, 18],
      safetyExcludedCountsByChunk: [10, 18]
    });
    const coordinator = createGmailScalableWorkflowCoordinator();
    expect(await coordinator.advance(fixture.jobId, "cleanup")).toMatchObject({ operation: "preflight_safety" });
    expect(await coordinator.advance(fixture.jobId, "cleanup")).toMatchObject({ operation: "preflight_safety" });
    const ready = await getState(fixture);
    expect(ready.view).toMatchObject({ status: "ready", requestedCount: 500, safeCount: 472, excludedCount: 28 });
    expect(ready.view.chunks.map((chunk) => ({ checked: chunk.preflightCheckedCount, approved: chunk.preflightSafeCount })))
      .toEqual([{ checked: 250, approved: 240 }, { checked: 250, approved: 232 }]);
    expect(dispatchCounts(ready, "dispatch_trash")).toEqual([0, 0]);
    await confirmGmailScalableWorkflowFixture(fixture.userId, fixture.jobId);
    await advanceUntilStatus(coordinator, fixture, "chunk_complete");

    const checkpoint = await getState(fixture);
    const browserCheckpoint = serializeGmailScalableJob(checkpoint);
    expect(checkpoint.view).toMatchObject({
      status: "chunk_complete",
      safeCount: 240,
      excludedCount: 10,
      attemptedCount: 240,
      verifiedCount: 240
    });
    expect(checkpoint.view.chunks[0]).toMatchObject({
      status: "complete",
      targetCount: 250,
      excludedCount: 10,
      safeCount: 240,
      attemptedCount: 240,
      verifiedCount: 240,
      failedCount: 0,
      uncertainCount: 0
    });
    expect(getGmailScalableJobProgress(browserCheckpoint)).toMatchObject({
      chunksComplete: 1,
      jobTerminal: false,
      nextChunk: 2,
      workflowContinuationExpected: true
    });
    expect(shouldPollGmailScalableJob(browserCheckpoint)).toBe(true);
    expect(browserCheckpoint.recoveryRestoreAvailable).toBe(true);
    expect(browserCheckpoint.recoveryRestoreCount).toBe(240);

    const run = await start(gmailScalableCleanupWorkflow, [fixture.jobId]);
    expect(await run.returnValue).toMatchObject({
      outcome: "stop",
      reason: "complete",
      status: "complete",
      verifiedCount: 472
    });
    const complete = await getState(fixture);
    expect(complete.view).toMatchObject({
      status: "complete",
      requestedCount: 500,
      safeCount: 472,
      excludedCount: 28,
      attemptedCount: 472,
      verifiedCount: 472,
      failedCount: 0,
      uncertainCount: 0,
      undoAvailable: true
    });
    expect(complete.view.chunks.map((chunk) => ({
      excluded: chunk.excludedCount,
      approved: chunk.safeCount,
      attempted: chunk.attemptedCount,
      verified: chunk.verifiedCount
    }))).toEqual([
      { excluded: 10, approved: 240, attempted: 240, verified: 240 },
      { excluded: 18, approved: 232, attempted: 232, verified: 232 }
    ]);
    expect(control(complete).verifiedProgress).toEqual([240, 472]);
    expect(dispatchCounts(complete, "dispatch_trash")).toEqual([1, 1]);
    expect(complete.payload.chunks.flatMap((chunk) => chunk.verifiedMovedIndexes)).toHaveLength(472);
    expect(shouldPollGmailScalableJob(serializeGmailScalableJob(complete))).toBe(false);
  });

  it("restores only the exact verified first-chunk ledger from an interrupted 500-message job", async () => {
    const fixture = await createFixture({
      requestedCount: 500,
      safetyExcludedCountsByChunk: [10, 18]
    });
    const coordinator = createGmailScalableWorkflowCoordinator();
    await advanceUntilStatus(coordinator, fixture, "chunk_complete");

    const prepared = await prepareGmailScalableWorkflowFixtureUndo(fixture.userId, fixture.jobId);
    expect(prepared.view).toMatchObject({ status: "undoing", restoreMode: "recovery", verifiedCount: 240 });
    expect(prepared.view.chunks.map((chunk) => chunk.status)).toEqual(["undoing", "pending"]);
    expect(prepared.payload.chunks[0].verifiedMovedIndexes).toHaveLength(240);
    expect(prepared.payload.chunks[1].verifiedMovedIndexes).toHaveLength(0);

    const undoRun = await start(gmailScalableUndoWorkflow, [fixture.jobId]);
    expect(await undoRun.returnValue).toMatchObject({
      outcome: "stop",
      reason: "complete",
      status: "undo_complete",
      verifiedRestoredCount: 240
    });
    expect(await createPrismaGmailScalableCleanupStore().get(fixture.userId, fixture.jobId)).toBeUndefined();
  });

  it("resumes a 500-message job from Prisma after a quota sleep without replaying chunk one", async () => {
    const fixture = await createFixture({
      requestedCount: 500,
      safetyExcludedCountsByChunk: [10, 18],
      quotaPauseBeforeCleanupChunkIndexes: [1]
    });
    const run = await start(gmailScalableCleanupWorkflow, [fixture.jobId]);
    const sleepId = await waitForSleep(run);

    const replacementStore = createPrismaGmailScalableCleanupStore();
    const paused = await requiredState(replacementStore, fixture);
    expect(paused.view.status).toBe("paused");
    expect(paused.view.nextEligibleRunAt).toBeGreaterThan(Date.now());
    expect(paused.view.verifiedCount).toBe(240);
    expect(control(paused).verifiedProgress).toEqual([240]);
    expect(dispatchCounts(paused, "dispatch_trash")).toEqual([1, 0]);

    await makeQuotaEligible(replacementStore, paused);
    await run.wakeUp({ correlationIds: [sleepId] });
    expect(await run.returnValue).toMatchObject({ outcome: "stop", reason: "complete", verifiedCount: 472 });

    const complete = await requiredState(createPrismaGmailScalableCleanupStore(), fixture);
    expect(control(complete).verifiedProgress).toEqual([240, 472]);
    expect(dispatchCounts(complete, "dispatch_trash")).toEqual([1, 1]);
  });

  it("serializes duplicate Workflow starts through the durable lock and CAS", async () => {
    const fixture = await createFixture({ requestedCount: 500, safetyExcludedCountsByChunk: [10, 18] });
    const firstWorker = createGmailScalableWorkflowCoordinator();
    await advanceUntilStatus(firstWorker, fixture, "chunk_complete");
    expect((await getState(fixture)).view.status).toBe("chunk_complete");

    const [firstRun, secondRun] = await Promise.all([
      start(gmailScalableCleanupWorkflow, [fixture.jobId]),
      start(gmailScalableCleanupWorkflow, [fixture.jobId])
    ]);
    const [firstResult, secondResult] = await Promise.all([firstRun.returnValue, secondRun.returnValue]);
    expect(firstResult).toMatchObject({ outcome: "stop", reason: "complete" });
    expect(secondResult).toMatchObject({ outcome: "stop", reason: "complete" });

    const state = await getState(fixture);
    expect(state.view.verifiedCount).toBe(472);
    expect(control(state).verifiedProgress).toEqual([240, 472]);
    expect(dispatchCounts(state, "dispatch_trash")).toEqual([1, 1]);
  });

  it("reclaims an expired lock and reconciles a persisted dispatch marker", async () => {
    const fixture = await createFixture({ requestedCount: 250 });
    const coordinator = createGmailScalableWorkflowCoordinator();
    expect(await coordinator.advance(fixture.jobId, "cleanup")).toMatchObject({ operation: "preflight_safety" });
    expect(await coordinator.advance(fixture.jobId, "cleanup")).toMatchObject({ operation: "safety_check" });
    expect(await coordinator.advance(fixture.jobId, "cleanup")).toMatchObject({ operation: "checkpoint_trash" });

    const store = createPrismaGmailScalableCleanupStore();
    const now = Date.now();
    const workerA = await store.claim(fixture.jobId, "fixture-worker-a", new Date(now), 50);
    expect(workerA).toBeDefined();
    const marked = markGmailScalableMutationDispatch(workerA!, "dispatch_trash");
    expect(marked).toBeDefined();
    const persisted = await store.compareAndSet(
      fixture.userId,
      fixture.jobId,
      workerA!.version,
      () => marked!,
      new Date(now),
      "fixture-worker-a"
    );
    expect(persisted?.payload.chunks[0].trashMutationDispatched).toBe(true);
    expect(await store.claim(fixture.jobId, "fixture-worker-b", new Date(now + 25), 50)).toBeUndefined();

    const reclaimed = await store.claim(fixture.jobId, "fixture-worker-b", new Date(now + 51), 50);
    expect(reclaimed?.payload.chunks[0].trashMutationDispatched).toBe(true);
    await store.releaseLock(fixture.jobId, "fixture-worker-b");

    const replacement = new GmailScalableWorkflowCoordinator(
      createPrismaGmailScalableCleanupStore(),
      new GmailScalableProviderWorkflowExecutor(),
      () => now + 52,
      () => "fixture-worker-c"
    );
    expect(await replacement.advance(fixture.jobId, "cleanup")).toMatchObject({ operation: "verify_trash" });
    const reconciled = await getState(fixture, new Date(now + 52));
    expect(reconciled.view.status).toBe("chunk_complete");
    expect(dispatchCounts(reconciled, "dispatch_trash")).toEqual([0]);
    expect(control(reconciled).operationLedger.filter((entry) => entry.operation === "verify_trash")).toHaveLength(1);
  });

  it.each([
    ["applied", "chunk_complete"],
    ["not_applied", "partial"],
    ["uncertain", "uncertain"]
  ] as const)("reconciles an unknown mutation result as %s", async (mutationOutcome, expectedStatus) => {
    const fixture = await createFixture({
      requestedCount: 250,
      mutationOutcome,
      interruptAfterTrashDispatchChunkIndexes: [0]
    });
    const coordinator = createGmailScalableWorkflowCoordinator();
    await coordinator.advance(fixture.jobId, "cleanup");
    await coordinator.advance(fixture.jobId, "cleanup");
    await coordinator.advance(fixture.jobId, "cleanup");
    await expect(coordinator.advance(fixture.jobId, "cleanup")).rejects.toBeInstanceOf(
      GmailScalableFixtureMutationInterruptedError
    );

    const interrupted = await getState(fixture);
    expect(interrupted.payload.chunks[0].trashMutationDispatched).toBe(true);
    expect(planGmailScalableWorkflowStep(interrupted, "cleanup")).toEqual({
      outcome: "run",
      operation: "verify_trash"
    });

    const replacement = createGmailScalableWorkflowCoordinator();
    expect(await replacement.advance(fixture.jobId, "cleanup")).toMatchObject({ operation: "verify_trash" });
    const reconciled = await getState(fixture);
    expect(reconciled.view.status).toBe(expectedStatus);
    expect(control(reconciled).operationLedger.filter((entry) => entry.operation === "dispatch_trash")).toHaveLength(0);
    expect(control(reconciled).operationLedger.filter((entry) => entry.operation === "verify_trash")).toHaveLength(1);
  });

  it("runs 1,000 messages in four durable chunks across a Workflow sleep", async () => {
    const fixture = await createFixture({
      requestedCount: 1_000,
      quotaPauseBeforeCleanupChunkIndexes: [2]
    });
    const run = await start(gmailScalableCleanupWorkflow, [fixture.jobId]);
    const sleepId = await waitForSleep(run);
    const replacementStore = createPrismaGmailScalableCleanupStore();
    const paused = await requiredState(replacementStore, fixture);
    expect(paused.view.verifiedCount).toBe(500);
    expect(control(paused).verifiedProgress).toEqual([250, 500]);

    await makeQuotaEligible(replacementStore, paused);
    await run.wakeUp({ correlationIds: [sleepId] });
    expect(await run.returnValue).toMatchObject({ outcome: "stop", reason: "complete", verifiedCount: 1_000 });

    const state = await getState(fixture);
    expect(state.view.chunkCount).toBe(4);
    expect(control(state).verifiedProgress).toEqual([250, 500, 750, 1_000]);
    expect(dispatchCounts(state, "dispatch_trash")).toEqual([1, 1, 1, 1]);
  });

  it("stops conservatively when chunk two is uncertain without replaying verified chunk one", async () => {
    const fixture = await createFixture({
      requestedCount: 500,
      mutationOutcomesByChunk: ["applied", "uncertain"]
    });
    const run = await start(gmailScalableCleanupWorkflow, [fixture.jobId]);
    expect(await run.returnValue).toMatchObject({ outcome: "stop", reason: "terminal", status: "uncertain", verifiedCount: 250 });

    const state = await getState(fixture);
    expect(state.view).toMatchObject({
      status: "uncertain",
      attemptedCount: 500,
      verifiedCount: 250,
      failedCount: 0,
      uncertainCount: 250,
      undoAvailable: false
    });
    expect(state.view.chunks.map((chunk) => chunk.status)).toEqual(["complete", "uncertain"]);
    expect(dispatchCounts(state, "dispatch_trash")).toEqual([1, 1]);
    expect(control(state).verifiedProgress).toEqual([250]);

    const recovery = serializeGmailScalableJob(state);
    expect(recovery).toMatchObject({ recoveryRestoreAvailable: true, recoveryRestoreCount: 250 });
    const prepared = await prepareGmailScalableWorkflowFixtureUndo(fixture.userId, fixture.jobId);
    expect(prepared.view.restoreMode).toBe("recovery");
    const undoRun = await start(gmailScalableUndoWorkflow, [fixture.jobId]);
    expect(await undoRun.returnValue).toMatchObject({ verifiedRestoredCount: 250 });
  });

  it("runs durable 500-message Undo across a restart and deletes terminal state", async () => {
    const fixture = await createFixture({
      requestedCount: 500,
      quotaPauseBeforeUndoChunkIndexes: [1]
    });
    const cleanupRun = await start(gmailScalableCleanupWorkflow, [fixture.jobId]);
    await cleanupRun.returnValue;
    const cleanupState = await getState(fixture);
    expect(cleanupState.payload.chunks.flatMap((chunk) => chunk.verifiedMovedIndexes)).toHaveLength(500);

    await prepareGmailScalableWorkflowFixtureUndo(fixture.userId, fixture.jobId);
    const undoRun = await start(gmailScalableUndoWorkflow, [fixture.jobId]);
    const sleepId = await waitForSleep(undoRun);
    const replacementStore = createPrismaGmailScalableCleanupStore();
    const paused = await requiredState(replacementStore, fixture);
    expect(paused.view.verifiedRestoredCount).toBe(250);
    expect(control(paused).restoredProgress).toEqual([250]);
    expect(dispatchCounts(paused, "dispatch_undo")).toEqual([1, 0]);
    expect(paused.view.chunks[0]).toMatchObject({ undoMutationRequests: 1, undoQuotaUnits: 53 });
    expect(paused.view.suggestedDeltas).toEqual([{ groupIndex: 0, verifiedMovedCount: 500, verifiedRestoredCount: 250 }]);

    await makeQuotaEligible(replacementStore, paused);
    await undoRun.wakeUp({ correlationIds: [sleepId] });
    expect(await undoRun.returnValue).toMatchObject({ outcome: "stop", reason: "complete", verifiedRestoredCount: 500 });
    expect(await replacementStore.get(fixture.userId, fixture.jobId)).toBeUndefined();
    const aggregate = await getGmailScalableWorkflowFixtureAggregate(fixture.jobId);
    expect(aggregate).toMatchObject({ status: "completed", terminalState: "undo_complete" });
    expect(aggregate?.terminalSnapshotVersion).toBeGreaterThan(0);
    expect(JSON.stringify(aggregate?.terminalSnapshot)).not.toMatch(/fixture-message-|uidValidity|historyCheckpoint|safeTargetIndexes/);
    const terminal = await getDurableGmailScalableCleanupStatus(fixture.userId, fixture.jobId);
    expect(terminal).toMatchObject({
      status: "undo_complete",
      chunksComplete: 2,
      verifiedCount: 500,
      verifiedRestoredCount: 500
    });
    expect(terminal.terminalDiagnostic).toContain("Job result: UNDO_COMPLETE");
  });

  it("fails closed when fixture state expires", async () => {
    const fixture = await createFixture({ requestedCount: 250 });
    await prisma.cleanupJobState.update({
      where: { jobId: fixture.jobId },
      data: { expiresAt: new Date(Date.now() - 1) }
    });
    const run = await start(gmailScalableCleanupWorkflow, [fixture.jobId]);
    expect(await run.returnValue).toMatchObject({ outcome: "stop", reason: "missing_state" });
    expect(await prisma.cleanupJobState.findUnique({ where: { jobId: fixture.jobId } })).toBeNull();
    expect(await getGmailScalableWorkflowFixtureAggregate(fixture.jobId)).toMatchObject({
      status: "cancelled",
      failureCode: "SCALABLE_STATE_UNAVAILABLE"
    });
  });

  it("deletes transient state and prevents resume after fixture disconnect", async () => {
    const fixture = await createFixture({ requestedCount: 500 });
    await clearGmailCleanupStateAfterDisconnect(fixture.userId);
    expect(await prisma.cleanupJobState.findUnique({ where: { jobId: fixture.jobId } })).toBeNull();
    expect(await getGmailScalableWorkflowFixtureAggregate(fixture.jobId)).toMatchObject({ status: "cancelled" });

    const run = await start(gmailScalableCleanupWorkflow, [fixture.jobId]);
    expect(await run.returnValue).toMatchObject({ outcome: "stop", reason: "missing_state" });
  });
});

async function createFixture(options: GmailScalableWorkflowFixtureOptions) {
  const fixture = await createGmailScalableWorkflowFixture(options);
  fixtureUsers.add(fixture.userId);
  return fixture;
}

async function getState(fixture: GmailScalableWorkflowFixtureIds, now?: Date) {
  return requiredState(createPrismaGmailScalableCleanupStore(), fixture, now);
}

async function requiredState(
  store: GmailScalableDurableCleanupStore,
  fixture: GmailScalableWorkflowFixtureIds,
  now?: Date
) {
  const state = await store.get(fixture.userId, fixture.jobId, now);
  if (!state) throw new Error("Expected fixture cleanup state to exist.");
  return state;
}

function control(state: GmailScalableStoredJob) {
  const fixture = state.payload.fixture;
  if (!fixture?.enabled) throw new Error("Expected encrypted fixture control state.");
  return fixture;
}

function dispatchCounts(
  state: GmailScalableStoredJob,
  operation: "dispatch_trash" | "dispatch_undo"
) {
  return state.payload.chunks.map((chunk) =>
    control(state).operationLedger.filter((entry) => entry.operation === operation && entry.chunkIndex === chunk.index).length
  );
}

async function makeQuotaEligible(store: GmailScalableDurableCleanupStore, paused: GmailScalableStoredJob) {
  const now = Date.now();
  const resumed = await store.compareAndSet(paused.userId, paused.view.id, paused.version, (job) => {
    job.view.nextEligibleRunAt = now - 1;
    job.payload.quotaWindow.startedAt = now - 60_001;
    return job;
  });
  expect(resumed).toBeDefined();
}

async function advanceUntilStatus(
  coordinator: GmailScalableWorkflowCoordinator,
  fixture: GmailScalableWorkflowFixtureIds,
  status: GmailScalableStoredJob["view"]["status"]
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await getState(fixture);
    if (state.view.status === status) return state;
    await coordinator.advance(fixture.jobId, "cleanup");
  }
  throw new Error(`Fixture did not reach ${status}.`);
}
