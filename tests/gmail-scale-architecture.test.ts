import { describe, expect, it } from "vitest";
import {
  GmailQuotaBudget,
  chunkUniqueGmailIds,
  estimateScalableGmailCleanup,
  formatGmailScaleDevelopmentSummary,
  gmailScalePolicy,
  gmailScaleQuotaUnits,
  reconcileTrashHistory,
  reconcileTrashHistoryAttempt,
  reconcileTrashList,
  selectBoundedGetFallback,
  summarizeScaleProgress
} from "@/lib/providers/gmail/scale-architecture";

describe("scalable Gmail architecture model", () => {
  it("keeps current official quota costs behind one boundary", () => {
    expect(gmailScaleQuotaUnits).toEqual({
      getProfile: 1,
      historyList: 2,
      messagesList: 5,
      messagesGet: 20,
      batchModify: 50,
      untrash: 5
    });
    expect(gmailScalePolicy).toMatchObject({
      providerUnitsPerUserMinute: 6_000,
      reserveUnits: 1_500,
      workingUnitsPerMinute: 4_500,
      bulkTrashRemovalUndoEnabled: false
    });
  });

  it.each([
    [100, 58, 500, 1],
    [500, 116, 2_500, 2],
    [1_000, 232, 5_000, 4],
    [5_000, 1_160, 25_000, 20]
  ])("estimates %i messages", (messages, beforeUndo, undo, chunks) => {
    expect(estimateScalableGmailCleanup(messages)).toMatchObject({ beforeUndo, individualUndo: undo, chunks });
  });

  it("charges retries and fallback against the budget", () => {
    const estimate = estimateScalableGmailCleanup(1_000, {
      fallbackListRequests: 2,
      fallbackGetRequests: 3,
      retryUnits: 50
    });
    expect(estimate.beforeUndo).toBe(352);

    const budget = new GmailQuotaBudget(100);
    expect(budget.consume(50)).toBe(true);
    expect(budget.consume(20)).toBe(true);
    expect(budget.consume(50)).toBe(false);
    expect(budget.snapshot).toEqual({ consumedUnits: 70, remainingUnits: 30 });
  });

  it("builds deterministic unique 250-message chunks", () => {
    const ids = Array.from({ length: 1_001 }, (_, index) => `id-${index}`);
    expect(chunkUniqueGmailIds(ids).map((chunk) => chunk.length)).toEqual([250, 250, 250, 250, 1]);
    expect(new Set(chunkUniqueGmailIds(ids).flat()).size).toBe(ids.length);
    expect(() => chunkUniqueGmailIds(["same", "same"])).toThrow(/duplicate/);
  });

  it("accepts only exact target-ID plus TRASH history evidence across pages", () => {
    const result = reconcileTrashHistory(["a", "b", "c"], [
      {
        history: [
          { labelsAdded: [{ message: { id: "unrelated" }, labelIds: ["TRASH"] }] },
          { labelsAdded: [{ message: { id: "a" }, labelIds: ["STARRED"] }] },
          { labelsAdded: [{ message: { id: "b" }, labelIds: ["TRASH"] }] }
        ],
        nextPageToken: "page-2"
      },
      { history: [{ labelsAdded: [{ message: { id: "a" }, labelIds: ["TRASH"] }] }] }
    ]);
    expect(result).toEqual({ verifiedIds: ["a", "b"], unresolvedIds: ["c"] });
  });

  it("treats missing history and history 404 handling as unresolved at the parser boundary", () => {
    expect(reconcileTrashHistory(["a", "b"], [])).toEqual({ verifiedIds: [], unresolvedIds: ["a", "b"] });
    expect(reconcileTrashHistoryAttempt(["a", "b"], { status: 404 })).toEqual({
      verifiedIds: [],
      unresolvedIds: ["a", "b"],
      historyUnavailable: true
    });
  });

  it("reconciles list results and sends only bounded unresolved exceptions to get", () => {
    const listed = reconcileTrashList(["a", "b", "c"], ["unrelated", "b"]);
    expect(listed).toEqual({ verifiedIds: ["b"], unresolvedIds: ["a", "c"] });
    expect(selectBoundedGetFallback(Array.from({ length: 12 }, (_, index) => `id-${index}`), 10)).toMatchObject({
      fallbackIds: expect.arrayContaining(["id-0", "id-9"]),
      heldUncertainCount: 2
    });
  });

  it("stops progress after partial failure or uncertainty and preserves accounting", () => {
    expect(summarizeScaleProgress([
      { attemptedCount: 250, verifiedCount: 250, failedCount: 0, uncertainCount: 0 },
      { attemptedCount: 250, verifiedCount: 248, failedCount: 1, uncertainCount: 1 }
    ])).toEqual({ attemptedCount: 500, verifiedCount: 498, failedCount: 1, uncertainCount: 1, canContinue: false });
    expect(() => summarizeScaleProgress([
      { attemptedCount: 10, verifiedCount: 9, failedCount: 0, uncertainCount: 0 }
    ])).toThrow(/accounting/);
  });

  it("produces an aggregate development summary without identifiers or destructive methods", () => {
    const summary = formatGmailScaleDevelopmentSummary({
      messagesTested: 10,
      xGmMsgidAvailable: 10,
      apiIdMatches: 10,
      mismatches: 0,
      safetyBenchmark: {
        targets: 1_000,
        restListPages: 5,
        restSafetyUnits: 25,
        imapExactRecheckSupported: true,
        imapComparisonMismatches: 0,
        personalListPages: 1
      }
    });
    expect(summary).toContain("500: 116 units");
    expect(summary).toContain("1,000: 232 units");
    expect(summary).toContain("5,000: 1,160 units");
    expect(summary).toContain("REST list pages: 5");
    expect(summary).toContain("IMAP exact recheck: supported");
    expect(summary).toContain("History pages per 250 targets: 1 estimated");
    expect(summary).toContain("bulk TRASH-label removal remains disabled");
    expect(summary).not.toMatch(/messages\.delete|batchDelete|threads\.delete|EXPUNGE|id-\d/);
  });

  it("models Personal pages per chunk instead of deriving pages from target count", () => {
    expect(estimateScalableGmailCleanup(1_000, { personalListPagesPerChunk: 3 })).toMatchObject({
      personalListPagesPerChunk: 3,
      safetyListRequests: 12,
      safety: 60,
      beforeUndo: 272
    });
  });
});
