import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { outlookCleanupBatchFixtureWorkflow } from "./fixtures/outlook-cleanup-workflow-fixture";

let originalFetch: typeof globalThis.fetch;
let microsoftProviderRequests = 0;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (/graph\.microsoft\.com/i.test(url)) {
      microsoftProviderRequests += 1;
      throw new Error("An Outlook Workflow fixture attempted a provider request.");
    }
    return originalFetch(input, init);
  };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe.sequential("Outlook cleanup Workflow fixtures", () => {
  it("continues a 500-message cleanup through 25 adaptive batches", async () => {
    const run = await start(outlookCleanupBatchFixtureWorkflow, [500, "cleanup"]);

    await expect(run.returnValue).resolves.toEqual({
      status: "complete",
      completedBatches: 25,
      processed: 500,
      totalBatches: 25,
      totalChunks: 5,
      httpRoundTrips: 75,
      graphSubrequests: 1500
    });
    expect(microsoftProviderRequests).toBe(0);
  });

  it("runs exact-ledger Undo through 25 adaptive batches", async () => {
    const run = await start(outlookCleanupBatchFixtureWorkflow, [500, "undo"]);

    await expect(run.returnValue).resolves.toEqual({
      status: "complete",
      completedBatches: 25,
      processed: 500,
      totalBatches: 25,
      totalChunks: 5,
      httpRoundTrips: 50,
      graphSubrequests: 1000
    });
    expect(microsoftProviderRequests).toBe(0);
  });

  it("stops before later batches after an uncertain mutation batch", async () => {
    const run = await start(outlookCleanupBatchFixtureWorkflow, [500, "cleanup", 7]);

    await expect(run.returnValue).resolves.toEqual({
      status: "uncertain",
      completedBatches: 6,
      processed: 120,
      totalBatches: 25
    });
    expect(microsoftProviderRequests).toBe(0);
  });
});
