import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getGmailCleanupRequestMode } from "@/lib/domain/gmail-cleanup-request-mode";
import { parseCleanupCount } from "@/lib/server/gmail-cleanup";
import { parseScalableCount } from "@/lib/server/gmail-scalable-cleanup-runner";

const enabledPolicy = {
  legacyMaximum: 100,
  scalableEnabled: true
} as const;

describe("Gmail cleanup request mode", () => {
  it.each([1, 5, 10, 25, 50, 99, 100])("keeps %i valid for the legacy flow", (requestedCount) => {
    expect(getGmailCleanupRequestMode({ ...enabledPolicy, requestedCount })).toBe("legacy");
  });

  it.each([101, 249, 251, 499, 501, 1_000])("rejects unsupported count %i", (requestedCount) => {
    expect(getGmailCleanupRequestMode({ ...enabledPolicy, requestedCount })).toBe("invalid");
  });

  it.each([250, 500])("routes %i through scalable cleanup when its gate is enabled", (requestedCount) => {
    expect(getGmailCleanupRequestMode({ ...enabledPolicy, requestedCount })).toBe("scalable");
  });

  it.each([250, 500])("rejects scalable count %i when its gate is disabled", (requestedCount) => {
    expect(getGmailCleanupRequestMode({ ...enabledPolicy, requestedCount, scalableEnabled: false })).toBe("invalid");
  });

  it("honors a configured legacy maximum below the hard maximum", () => {
    expect(getGmailCleanupRequestMode({ requestedCount: 25, legacyMaximum: 25, scalableEnabled: true })).toBe("legacy");
    expect(getGmailCleanupRequestMode({ requestedCount: 26, legacyMaximum: 25, scalableEnabled: true })).toBe("invalid");
  });
});

describe("Gmail cleanup route boundaries", () => {
  it("accepts 500 only at the scalable server boundary", () => {
    expect(parseScalableCount(500)).toBe(500);
    expect(() => parseCleanupCount(500)).toThrow(/development limit/);
  });

  it("uses the shared mode decision to route scalable UI requests", () => {
    const root = process.cwd();
    const client = fs.readFileSync(path.join(root, "src/components/product/GmailCleanupClient.tsx"), "utf8");
    const scalableRoute = fs.readFileSync(path.join(root, "app/api/dev/gmail-scalable-cleanup/start/route.ts"), "utf8");
    const legacyRoute = fs.readFileSync(path.join(root, "app/api/dev/gmail-cleanup/resolve/route.ts"), "utf8");

    expect(client).toContain("getGmailCleanupRequestMode");
    expect(client).toContain('const scalable = cleanupRequestMode === "scalable"');
    expect(client).toMatch(/scalable \? "\/api\/dev\/gmail-scalable-cleanup\/start" : "\/api\/dev\/gmail-cleanup\/resolve"/);
    expect(client).not.toContain("requestedCount === 250");
    expect(scalableRoute).toContain("startGmailScalableCleanup");
    expect(scalableRoute).not.toContain("createGmailCleanupPreview");
    expect(legacyRoute).toContain("createGmailCleanupPreview");
    expect(legacyRoute).not.toContain("startGmailScalableCleanup");
  });
});
