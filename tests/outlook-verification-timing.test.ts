import { afterEach, expect, it, vi } from "vitest";
import { currentVerificationTrace, logCompletedVerification, measureVerification, newVerificationTrace,
  recordWorkflowArrival, verificationCompleted, verificationWorkflowSeed, withVerificationTrace } from "@/lib/server/outlook-verification-timing";
import { createOutlookVerificationClientTiming, outlookVerificationTimingHeader } from "@/lib/outlook-verification-client-timing";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const correlationId = "11111111-1111-4111-8111-111111111111";
it("carries aggregate timing across serialized Workflow steps without state writes and reports gaps separately", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const trace = newVerificationTrace(correlationId);
  let seed = trace;
  await withVerificationTrace(trace, async () => {
    await measureVerification("database_read", async () => { vi.advanceTimersByTime(10); return { secret: "not logged" }; });
    seed = verificationWorkflowSeed()!;
  });
  expect(currentVerificationTrace()).toBeUndefined();
  vi.advanceTimersByTime(1000);
  for (let index = 0; index < 2; index++) {
    seed = JSON.parse(JSON.stringify(seed));
    await withVerificationTrace(seed, async () => {
      recordWorkflowArrival(seed);
      await measureVerification("worker_unit", async () => {
        await measureVerification("targeted_graph", async () => { vi.advanceTimersByTime(20); });
        await measureVerification("database_write", async () => { vi.advanceTimersByTime(5); });
      });
      seed.lastStepEndedAt = Date.now();
      if (index === 1) {
        verificationCompleted({ requestedCount: 40, candidatesChecked: 40, graphBatchRequests: 2, verificationDurationMs: 40, status: "ready" });
        logCompletedVerification();
      }
    });
    if (!index) vi.advanceTimersByTime(500);
  }
  const summaries = log.mock.calls.filter(call => call[0] === "Outlook verification end-to-end");
  expect(summaries).toHaveLength(1);
  expect(summaries[0][1]).toMatchObject({ correlationId, graphDurationMs: 40, workflowStartupMs: 1000,
    workflowGapMs: 500, databaseMs: 20, workerMs: 50, bootstrapMs: 10, serverTotalMs: 1560, wallResidualMs: 0 });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|not logged/);
});
it("does not log without a trace, preserves failures and isolates simultaneous request context", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = new Error("raw token and mailbox response");
  await expect(measureVerification("credentials", async () => { throw error; })).rejects.toBe(error);
  expect(log).not.toHaveBeenCalled();
  await Promise.all([correlationId, "22222222-2222-4222-8222-222222222222"].map(id =>
    withVerificationTrace(newVerificationTrace(id), async () => {
      await Promise.resolve(); expect(currentVerificationTrace()?.correlationId).toBe(id);
      await expect(measureVerification("credentials", async () => { throw error; })).rejects.toBe(error);
    })));
  expect(log).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/token|mailbox|response/);
  expect(currentVerificationTrace()).toBeUndefined();
});
it("separates click-to-accept, polling/network waits and result rendering using only a local monotonic clock", () => {
  let clock = 0;
  vi.spyOn(Date, "now").mockReturnValue(300_000);
  const timing = createOutlookVerificationClientTiming(() => clock);
  clock = 5000;
  timing.response(new Response(null, { headers: { [outlookVerificationTimingHeader]: correlationId } }), 0, "created", true);
  expect(timing.headers()).toEqual({ [outlookVerificationTimingHeader]: correlationId });
  clock = 60_000;
  timing.response(new Response(null, { headers: { "X-Outlook-Ready-Checkpoint-Age-Ms": "2000" } }), 59_500, "ready");
  clock = 60_020;
  expect(timing.visible()).toEqual({ correlationId, clientTotalMs: 60_020, startRequestMs: 5000,
    pollRequests: 1, pollHttpMs: 500, pollingAndWaitMs: 54_500, renderAfterReadyResponseMs: 20,
    readyCheckpointToVisibleUpperBoundMs: 2520 });
  expect(timing.visible()).toBeUndefined();
});
it("never reports a ready sample before readiness or without an accepted correlation ID", () => {
  const timing = createOutlookVerificationClientTiming(() => 0);
  expect(timing.visible()).toBeUndefined();
  timing.response(new Response(), 0, "ready", true);
  expect(timing.visible()).toBeUndefined();
});
