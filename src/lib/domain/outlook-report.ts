import { assessMessage, RECURRING_SENDER_MIN_MESSAGES, SIGNIFICANT_PROTECTED_RATIO, VERY_HIGH_MIN_ELIGIBLE_MESSAGES, VERY_HIGH_OLD_RATIO, VERY_HIGH_VERY_OLD_RATIO } from "./recommendations";
import { StreamingReportAggregator } from "./streaming-aggregator";
import type { CleanupRecommendation, InboxReport, NormalizedMailboxRecord, SenderAggregate } from "./types";
import { buildCleanupSenderGroups } from "../providers/gmail/cleanup-candidates";

export type OutlookBaseState = { assessedAt: number; records: NormalizedMailboxRecord[] };

export function createOutlookBaseState(records: NormalizedMailboxRecord[], assessedAt: number): OutlookBaseState {
  return { assessedAt, records: records.map(record => ({ ...record,
    listId: undefined, hasListUnsubscribe: false, precedence: undefined, autoSubmitted: undefined })) };
}

function isPotential(record: NormalizedMailboxRecord, state: OutlookBaseState, participated: ReadonlySet<string>) {
  const assessed = assessMessage({ ...record, receivedAt: new Date(record.receivedAt) }, {
    now: new Date(state.assessedAt), participatedConversationIds: participated
  });
  return !assessed.isProtected && !record.isDeleted && ["old", "very_old"].includes(assessed.ageBand) && !record.userLabels?.length;
}

export function snapshotOutlookBase(state: OutlookBaseState, participated: ReadonlySet<string>, includeDiagnostics = false): InboxReport {
  const aggregator = new StreamingReportAggregator({ now: new Date(state.assessedAt), participatedConversationIds: participated, includeDiagnostics });
  const potential = new Map<string, number>();
  const warnings = new Map<string, number>();
  for (const record of state.records) {
    aggregator.process({ ...record, receivedAt: new Date(record.receivedAt) });
    if (isPotential(record, state, participated)) potential.set(record.senderAddress, (potential.get(record.senderAddress) ?? 0) + 1);
    if (record.subjectProtection || record.userLabels?.length || record.providerCategory === "personal" || record.providerCategory === "updates") {
      warnings.set(record.senderAddress, (warnings.get(record.senderAddress) ?? 0) + 1);
    }
  }
  const report = aggregator.snapshot("microsoft", false);
  report.totals.potentialCleanup = 0;
  for (const sender of report.senders) {
    const count = potential.get(sender.senderKey) ?? 0;
    let recommendation: CleanupRecommendation = "review";
    const protectedRatio = sender.protectedMessages / sender.totalMessages;
    const warningRatio = (warnings.get(sender.senderKey) ?? 0) / sender.totalMessages;
    if (sender.protectedMessages === sender.totalMessages) recommendation = "keep";
    else if (sender.recurring && count >= RECURRING_SENDER_MIN_MESSAGES && protectedRatio < SIGNIFICANT_PROTECTED_RATIO &&
        warningRatio === 0 && sender.oldMessages / sender.totalMessages >= 0.5) {
      recommendation = count >= VERY_HIGH_MIN_ELIGIBLE_MESSAGES && protectedRatio < 0.2 &&
        (sender.oldMessages / sender.totalMessages >= VERY_HIGH_OLD_RATIO || sender.veryOldMessages / sender.totalMessages >= VERY_HIGH_VERY_OLD_RATIO)
        ? "very_high" : "high";
    }
    sender.reviewRecommendation = recommendation;
    sender.potentialCleanupCount = ["high", "very_high"].includes(recommendation) ? count : 0;
    // Recommendation counts are separate from exact classifier eligibility.
    report.totals.potentialCleanup += sender.potentialCleanupCount;
  }
  for (const category of report.categories) {
    category.potentialCleanupCount = report.senders.filter(sender => sender.classification === category.category)
      .reduce((sum, sender) => sum + (sender.potentialCleanupCount ?? 0), 0);
  }
  return report;
}

export function outlookCandidatePool(state: OutlookBaseState, participated: ReadonlySet<string>, selected: Array<{ groupIndex: number; senderKey: string }>) {
  const groups = new Map(selected.map(group => [group.senderKey, group.groupIndex]));
  const seen = new Set<string>();
  return state.records.flatMap(record => {
    const groupIndex = groups.get(record.senderAddress);
    if (groupIndex === undefined || !isPotential(record, state, participated) || seen.has(record.providerMessageId)) return [];
    seen.add(record.providerMessageId);
    return [{ messageId: record.providerMessageId, groupIndex }];
  });
}

export function buildOutlookCleanupSenderGroups(senders: SenderAggregate[]) {
  return buildCleanupSenderGroups(senders.map(sender => ({ ...sender,
    cleanupCandidateCount: sender.potentialCleanupCount ?? 0,
    cleanupConfidence: sender.reviewRecommendation ?? "keep",
    reviewMessages: Math.max(0, sender.reviewMessages - (sender.potentialCleanupCount ?? 0))
  })));
}

export const reportCleanupCount = (report: InboxReport) => report.totals.potentialCleanup ?? report.totals.cleanupCandidates;
export const senderCleanupCount = (sender: SenderAggregate) => sender.potentialCleanupCount ?? sender.cleanupCandidateCount;
export const senderRecommendation = (sender: SenderAggregate) => sender.reviewRecommendation ?? sender.cleanupConfidence;
export const senderReviewCount = (sender: SenderAggregate) => Math.max(0, sender.reviewMessages - (sender.potentialCleanupCount ?? 0));
