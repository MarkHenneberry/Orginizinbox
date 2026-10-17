import { describe, expect, it } from "vitest";
import { createOutlookProgressiveState, applyOutlookEvidence, snapshotOutlookProgressive, outlookVerification, verifiedOutlookMessageIds } from "@/lib/domain/outlook-progressive";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import type { NormalizedMailboxRecord } from "@/lib/domain/types";

const now = Date.UTC(2026, 9, 17);
const record = (id: number, overrides: Partial<NormalizedMailboxRecord> = {}): NormalizedMailboxRecord => ({
  provider: "microsoft", providerMessageId: `message-${id}`, senderAddress: "newsletter@example.test", receivedAt: new Date("2020-01-01"),
  isRead: false, hasListUnsubscribe: false, ...overrides
});
const evidence = { listId: "private-list-id", hasListUnsubscribe: true, precedence: "bulk", autoSubmitted: "auto-generated" };

describe("progressive Outlook classifier safety", () => {
  it("publishes the full base report while all candidates remain Review, then promotes only exact verified messages", () => {
    const state = createOutlookProgressiveState([record(1), record(2), record(3)], new Set(), now);
    const base = snapshotOutlookProgressive(state, new Set());
    expect(base.totals).toMatchObject({ messages: 3, cleanupCandidates: 0, reviewMessages: 3 });
    expect(base.senders[0].pendingVerificationCount).toBe(3);
    applyOutlookEvidence(state, 0, evidence);
    const next = snapshotOutlookProgressive(state, new Set());
    expect(next.totals).toMatchObject({ messages: 3, cleanupCandidates: 1, reviewMessages: 2 });
    expect(verifiedOutlookMessageIds(state, next, new Set())).toEqual(["message-1"]);
    expect(next.senders[0].pendingVerificationCount).toBe(2);
    applyOutlookEvidence(state, 0, evidence);
    expect(snapshotOutlookProgressive(state, new Set()).totals).toEqual(next.totals);
  });
  it("missing/failed evidence stays Review; encrypted normalized state needs no raw header values", () => {
    const state = createOutlookProgressiveState([record(1), record(2), record(3)], new Set(), now);
    applyOutlookEvidence(state, 0, evidence); applyOutlookEvidence(state, 1, undefined);
    applyOutlookEvidence(state, 2, { hasListUnsubscribe: false });
    expect(outlookVerification(state)).toEqual({ candidates: 3, checked: 3, failed: 1, status: "complete" });
    expect(snapshotOutlookProgressive(state, new Set()).totals.cleanupCandidates).toBe(1);
    expect(JSON.stringify(state)).not.toMatch(/private-list-id|internetMessageHeaders|Subject|bodyPreview/);
  });
  it.each([
    { isStarred: true }, { isImportant: true }, { isSent: true }, { isDraft: true },
    { isDeleted: true, isExcludedMailboxLocation: true }, { subjectProtection: "transactional" as const },
    { subjectProtection: "security_account" as const }, { hasUncertainMetadata: true },
    { receivedAt: new Date(now) }, { conversationId: "participated" }
  ])("keeps hard protection through both stages: %j", protection => {
    const participated = new Set(["participated"]);
    const state = createOutlookProgressiveState([record(1, protection), record(2), record(3)], participated, now);
    expect(state.records[0].verification).toBeUndefined();
    for (const index of state.queue) applyOutlookEvidence(state, index, evidence);
    const report = snapshotOutlookProgressive(state, participated);
    expect(report.totals.protectedMessages).toBe(1);
    expect(verifiedOutlookMessageIds(state, report, participated)).not.toContain("message-1");
  });
  it("matches the unchanged full-evidence classifier for enriched messages and recomputes categories without double counting", () => {
    const records = Array.from({ length: 30 }, (_, index) => record(index));
    const state = createOutlookProgressiveState(records, new Set(), now);
    const baseline = new StreamingReportAggregator({ now: new Date(now) });
    baseline.processBatch(records.map(message => ({ ...message, ...evidence })));
    for (const index of state.queue) applyOutlookEvidence(state, index, evidence);
    const report = snapshotOutlookProgressive(state, new Set());
    expect(report.totals).toEqual(baseline.snapshot("microsoft").totals);
    expect(report.categories).toEqual(baseline.snapshot("microsoft").categories);
    expect(report.senders[0].cleanupConfidence).toBe("very_high");
    const recovered = JSON.parse(JSON.stringify(state));
    expect(snapshotOutlookProgressive(recovered, new Set()).totals).toEqual(report.totals);
  });
  it("prioritizes the largest recurring old sender and skips groups that cannot become Suggested", () => {
    const records = [record(1), record(2), record(3), ...Array.from({ length: 10 }, (_, i) => record(4 + i, { senderAddress: "largest@example.test" })),
      record(14, { senderAddress: "unique@example.test" }), ...Array.from({ length: 3 }, (_, i) => record(15 + i, { senderAddress: "labeled@example.test", userLabels: ["Work"] }))];
    const state = createOutlookProgressiveState(records, new Set(), now);
    expect(state.records[state.queue[0]].record.senderAddress).toBe("largest@example.test");
    expect(state.queue).toHaveLength(13);
  });
});
