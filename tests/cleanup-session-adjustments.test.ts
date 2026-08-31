import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getSessionAdjustedSuggestedCount,
  getSessionAdjustedSuggestedTotal,
  mergeCleanupSuggestedDeltas
} from "@/lib/domain/cleanup-session-adjustments";
import { countVerifiedCandidatesByGroup } from "@/lib/server/gmail-cleanup-adjustments";

describe("cleanup session Suggested-count adjustments", () => {
  it("decrements only exact verified moved candidates and distributes them by sender group", () => {
    const candidates = [
      { apiMessageId: "verified-a", groupIndex: 2, requiresMutableStrongEvidenceRecheck: false },
      { apiMessageId: "failed", groupIndex: 2, requiresMutableStrongEvidenceRecheck: false },
      { apiMessageId: "verified-b", groupIndex: 7, requiresMutableStrongEvidenceRecheck: false },
      { apiMessageId: "uncertain", groupIndex: 7, requiresMutableStrongEvidenceRecheck: false }
    ];
    const verifiedCounts = countVerifiedCandidatesByGroup(candidates, ["verified-a", "verified-b"]);
    expect(verifiedCounts).toEqual([{ groupIndex: 2, count: 1 }, { groupIndex: 7, count: 1 }]);

    const deltas = mergeCleanupSuggestedDeltas([], verifiedCounts, "moved");
    expect(getSessionAdjustedSuggestedCount(835, deltas[0])).toBe(834);
    expect(getSessionAdjustedSuggestedCount(655, deltas[1])).toBe(654);
    expect(getSessionAdjustedSuggestedCount(481, undefined)).toBe(481);
  });

  it("never drops a displayed count below zero and keeps zero-count senders represented", () => {
    const delta = mergeCleanupSuggestedDeltas([], [{ groupIndex: 4, count: 3 }], "moved")[0];
    const groups = [{ index: 4, cleanupCandidateCount: 1 }, { index: 8, cleanupCandidateCount: 5 }];
    expect(getSessionAdjustedSuggestedCount(1, delta)).toBe(0);
    expect(getSessionAdjustedSuggestedTotal(groups, [delta])).toBe(5);
    expect(groups.map((group) => group.index)).toEqual([4, 8]);
  });

  it("composes verified cleanup and verified Undo deltas without restoring failed or uncertain outcomes", () => {
    const moved = mergeCleanupSuggestedDeltas([], [
      { groupIndex: 1, count: 2 },
      { groupIndex: 3, count: 1 }
    ], "moved");
    const partiallyRestored = mergeCleanupSuggestedDeltas(moved, [{ groupIndex: 1, count: 1 }], "restored");
    expect(getSessionAdjustedSuggestedCount(10, partiallyRestored.find((delta) => delta.groupIndex === 1))).toBe(9);
    expect(getSessionAdjustedSuggestedCount(10, partiallyRestored.find((delta) => delta.groupIndex === 3))).toBe(9);

    const fullyRestored = mergeCleanupSuggestedDeltas(partiallyRestored, [
      { groupIndex: 1, count: 1 },
      { groupIndex: 3, count: 1 }
    ], "restored");
    expect(getSessionAdjustedSuggestedTotal([
      { index: 1, cleanupCandidateCount: 10 },
      { index: 3, cleanupCandidateCount: 10 }
    ], fullyRestored)).toBe(20);
  });

  it("serializes only aggregate group deltas", () => {
    const deltas = mergeCleanupSuggestedDeltas([], [{ groupIndex: 2, count: 4 }], "moved");
    const serialized = JSON.stringify(deltas);
    expect(serialized).toBe('[{"groupIndex":2,"verifiedMovedCount":4,"verifiedRestoredCount":0}]');
    expect(serialized).not.toMatch(/gmail|message|subject|header|query|token/i);
  });

  it("adds no provider request or automatic scan to completion adjustment", () => {
    const adjustment = readFileSync("src/lib/domain/cleanup-session-adjustments.ts", "utf8");
    const serverAdjustment = readFileSync("src/lib/server/gmail-cleanup-adjustments.ts", "utf8");
    expect(`${adjustment}\n${serverAdjustment}`).not.toMatch(/fetch\(|ImapFlow|messages\.get|messages\.list|gmail\.googleapis|gmail-scan/);
  });

  it("keeps the report stale and derives deltas after authoritative verification", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    expect(cleanup).toMatch(/markLiveReportStale\(userId\)/);
    expect(cleanup).not.toMatch(/markLiveReportCurrent|reportStale:\s*false/);
    expect(cleanup.indexOf("verifyMessagesInTrash(eligibleIds)")).toBeLessThan(
      cleanup.indexOf("countVerifiedCandidatesByGroup(eligibleCandidates, verification.verifiedIds)")
    );
    expect(cleanup.indexOf("untrashAndVerifyMessages(apiMessageIds)")).toBeLessThan(
      cleanup.indexOf("countVerifiedCandidatesByGroup(job.apiCandidates, verification.verifiedIds)")
    );
  });

  it("keeps Gmail IDs out of the serialized client adjustment contract", () => {
    const store = readFileSync("src/lib/server/gmail-cleanup-store.ts", "utf8");
    const serialized = store.slice(store.indexOf("export function serializeGmailCleanupJob"));
    expect(serialized).toContain("suggestedDeltas: (job.suggestedDeltas ?? []).map");
    expect(serialized).not.toMatch(/apiCandidates:\s*job\.apiCandidates/);
  });
});
