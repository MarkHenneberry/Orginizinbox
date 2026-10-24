import { expect, it } from "vitest";
import { importKey } from "@workflow/core/encryption";
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  dehydrateWorkflowReturnValue,
  hydrateStepArguments,
  hydrateStepReturnValue,
  hydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
  isEncrypted
} from "@workflow/core/serialization";

const runId = "wrun_dependency_compatibility";
const trace = {
  correlationId: "00000000-0000-4000-8000-000000000001",
  receivedAt: 1_792_454_400_000,
  step: 12,
  bootstrapMs: 10,
  totals: { targeted_graph: 1234.5, database_write: 8 }
};

it.each([
  { name: "Workflow arguments", encode: dehydrateWorkflowArguments, decode: hydrateWorkflowArguments },
  { name: "step arguments", encode: dehydrateStepArguments, decode: hydrateStepArguments },
  { name: "step results", encode: dehydrateStepReturnValue, decode: hydrateStepReturnValue },
  { name: "Workflow results", encode: dehydrateWorkflowReturnValue, decode: hydrateWorkflowReturnValue }
])("preserves $name with the patched Workflow 4 serializer", async ({ encode, decode }) => {
  const shared = { outcome: "continue", verificationTrace: trace };
  const value = ["synthetic-job", "prepare", shared, shared, {
    when: new Date(trace.receivedAt),
    bytes: new Uint8Array([0, 1, 255]),
    counts: new Map([["verified", 20]]),
    phases: new Set(["prepare", "undo"]),
    optional: undefined
  }];
  const restored = await decode(await encode(value, runId, undefined), runId, undefined);
  expect(restored).toEqual(value);
  expect(restored[2]).toBe(restored[3]);
});

it("continues to read the legacy JSON-array Workflow wire format", async () => {
  const value = ["synthetic-job", "prepare", trace];
  const legacy = await dehydrateWorkflowArguments(value, runId, undefined, [], globalThis, true);
  expect(Array.isArray(legacy)).toBe(true);
  expect(await hydrateWorkflowArguments(legacy, runId, undefined)).toEqual(value);
});

it("preserves encrypted step recovery results and rejects a wrong encryption key", async () => {
  const key = await importKey(new Uint8Array(32).fill(71));
  const wrongKey = await importKey(new Uint8Array(32).fill(72));
  const result = { outcome: "continue", verificationTrace: trace };
  const serialized = await dehydrateStepReturnValue(result, runId, key);
  expect(isEncrypted(serialized)).toBe(true);
  expect(await hydrateStepReturnValue(serialized, runId, key)).toEqual(result);
  await expect(hydrateStepReturnValue(serialized, runId, wrongKey)).rejects.toThrow();
});
