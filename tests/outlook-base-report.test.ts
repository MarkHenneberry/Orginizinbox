import { expect, it } from "vitest";
import { assessMessage } from "@/lib/domain/recommendations";
import { buildOutlookCleanupSenderGroups, createOutlookBaseState, outlookCandidatePool, snapshotOutlookBase } from "@/lib/domain/outlook-report";
import type { NormalizedMailboxRecord } from "@/lib/domain/types";

const now = Date.UTC(2026, 9, 17);
const records = (count = 30, overrides: Partial<NormalizedMailboxRecord> = {}): NormalizedMailboxRecord[] => Array.from({ length: count }, (_, i) => ({
  provider: "microsoft", providerMessageId: `private-${i}`, senderAddress: "news@example.test", isRead: false,
  receivedAt: new Date("2020-01-01"), ...overrides
}));
it("provides a Very High review recommendation immediately without inventing exact cleanup evidence", () => {
  const state = createOutlookBaseState(records(), now);
  const report = snapshotOutlookBase(state, new Set());
  expect(report.totals).toMatchObject({ messages: 30, potentialCleanup: 30, cleanupCandidates: 0, reviewMessages: 30 });
  expect(report.senders[0]).toMatchObject({ reviewRecommendation: "very_high", potentialCleanupCount: 30, cleanupCandidateCount: 0 });
  expect(state.records.every(record => !assessMessage(record, { now: new Date(now) }).eligibleForCleanup)).toBe(true);
  expect(buildOutlookCleanupSenderGroups(report.senders)[0]).toMatchObject({ eligible: true, cleanupCandidateCount: 30 });
  expect(snapshotOutlookBase(createOutlookBaseState(records(4), now), new Set()).senders[0].reviewRecommendation).toBe("high");
});
it.each([
  { isStarred: true }, { isImportant: true }, { isSent: true }, { isDraft: true }, { isDeleted: true },
  { hasUncertainMetadata: true }, { subjectProtection: "transactional" as const }, { subjectProtection: "security_account" as const },
  { receivedAt: new Date(now) }, { conversationId: "participated" }, { providerCategory: "personal" as const }, { userLabels: ["Keep"] }
])("never aggressively recommends protected or warning-heavy groups: %j", protection => {
  const state = createOutlookBaseState(records(30, protection), now);
  const report = snapshotOutlookBase(state, new Set(["participated"]));
  expect(report.totals.potentialCleanup).toBe(0);
  expect(["keep", "review"]).toContain(report.senders[0].reviewRecommendation);
  expect(buildOutlookCleanupSenderGroups(report.senders)[0].eligible).toBe(false);
});
it("keeps significant protected subsets conservative and freezes only selected exact IDs without headers", () => {
  const state = createOutlookBaseState([...records(15, { isStarred: true }), ...records(15), ...records(5, { senderAddress: "other@example.test", providerMessageId: "other" })], now);
  expect(snapshotOutlookBase(state, new Set()).senders.find(sender => sender.senderKey === "news@example.test")?.reviewRecommendation).toBe("review");
  const pool = outlookCandidatePool(state, new Set(), [{ groupIndex: 4, senderKey: "other@example.test" }]);
  expect(pool).toEqual([{ messageId: "other", groupIndex: 4 }]);
  const sanitized = createOutlookBaseState(records(3, { listId: "raw-header", hasListUnsubscribe: true }), now);
  expect(JSON.stringify(sanitized)).not.toContain("raw-header");
  expect(snapshotOutlookBase(JSON.parse(JSON.stringify(sanitized)), new Set()).totals.cleanupCandidates).toBe(0);
});
