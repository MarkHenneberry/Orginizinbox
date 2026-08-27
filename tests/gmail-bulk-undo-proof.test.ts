import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertGmailBulkUndoProofInput,
  executeGmailBulkUndoProof
} from "@/lib/providers/gmail/bulk-undo-proof";

describe("Gmail bulk Undo proof preparation", () => {
  it("hard-gates exactly five unique messages and explicit development approval", () => {
    const ids = Array.from({ length: 5 }, (_, index) => `id-${index}`);
    expect(assertGmailBulkUndoProofInput({ enabled: true, approved: true, nodeEnv: "development", targetIds: ids })).toEqual(ids);
    expect(() => assertGmailBulkUndoProofInput({ enabled: true, approved: true, nodeEnv: "development", targetIds: ids.slice(0, 4) })).toThrow(/exactly 5/);
    expect(() => assertGmailBulkUndoProofInput({ enabled: false, approved: true, nodeEnv: "development", targetIds: ids })).toThrow(/disabled/);
    expect(() => assertGmailBulkUndoProofInput({ enabled: true, approved: false, nodeEnv: "development", targetIds: ids })).toThrow(/disabled/);
    expect(() => assertGmailBulkUndoProofInput({ enabled: true, approved: true, nodeEnv: "production", targetIds: ids })).toThrow(/disabled/);
  });

  it("prepares only batch removal of TRASH and verifies all five without permanent deletion", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const result = await executeGmailBulkUndoProof({
      accessToken: "token",
      targetIds: ["a", "b", "c", "d", "e"],
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
        if (String(url).endsWith("batchModify")) return new Response(null, { status: 200 });
        const id = decodeURIComponent(String(url).match(/\/messages\/([^?]+)/)?.[1] ?? "");
        return new Response(JSON.stringify({ id, labelIds: ["INBOX"] }), { status: 200 });
      }
    });
    expect(result).toMatchObject({ attemptedCount: 5, verifiedRestoredCount: 5, batchModifyRequests: 1, verificationRequests: 5 });
    expect(JSON.parse(requests[0].body!)).toEqual({
      ids: ["a", "b", "c", "d", "e"],
      addLabelIds: [],
      removeLabelIds: ["TRASH"]
    });
    expect(requests.map((request) => request.url).join("\n")).not.toMatch(/batchDelete|\/delete|threads|expunge/i);
  });

  it("keeps client-supplied Gmail IDs out of the prepared route", () => {
    const route = readFileSync("app/api/dev/gmail-bulk-undo-proof/route.ts", "utf8");
    expect(route).toMatch(/job\.apiCandidates\.map/);
    expect(route).toMatch(/job\.attemptedCount !== 5/);
    expect(route).toMatch(/job\.apiCandidates\.length !== 5/);
    expect(route).not.toMatch(/body\.(ids|targetIds|messageIds)/);
  });
});
