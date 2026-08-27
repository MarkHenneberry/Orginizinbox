import { categoryLabel } from "@/lib/domain/recommendations";
import type { CategoryAggregate, InboxReport, MailCategory, ReportSource } from "@/lib/domain/types";

export type CleanupReviewGroup = {
  key: MailCategory;
  label: string;
  selectedCount: number;
  totalMessages: number;
  unreadMessages: number;
  oldMessages: number;
  protectedMessages: number;
  estimatedBytes: number;
};

export type CleanupReview = {
  reportSource: ReportSource;
  provider: InboxReport["provider"];
  fixtureMode: boolean;
  totalMessages: number;
  cleanupCandidateCount: number;
  protectedMessages: number;
  selectedUniqueCleanupCount: number;
  groups: CleanupReviewGroup[];
};

export function buildCleanupReview(report: InboxReport, reportSource: ReportSource): CleanupReview {
  const groups = report.categories.filter((category) => category.cleanupCandidateCount > 0).map(toCleanupGroup);
  const selectedUniqueCleanupCount = groups.reduce((total, group) => total + group.selectedCount, 0);

  if (report.totals.cleanupCandidates > report.totals.messages) {
    throw new Error("Invalid report: cleanup candidates exceed total messages.");
  }
  if (report.totals.protectedMessages > report.totals.messages) {
    throw new Error("Invalid report: protected messages exceed total messages.");
  }
  if (selectedUniqueCleanupCount > report.totals.cleanupCandidates) {
    throw new Error("Invalid cleanup review: selected cleanup count exceeds report cleanup candidates.");
  }

  return {
    reportSource,
    provider: report.provider,
    fixtureMode: report.fixtureMode,
    totalMessages: report.totals.messages,
    cleanupCandidateCount: report.totals.cleanupCandidates,
    protectedMessages: report.totals.protectedMessages,
    selectedUniqueCleanupCount,
    groups
  };
}

function toCleanupGroup(category: CategoryAggregate): CleanupReviewGroup {
  return {
    key: category.category,
    label: categoryLabel(category.category),
    selectedCount: category.cleanupCandidateCount,
    totalMessages: category.totalMessages,
    unreadMessages: category.unreadMessages,
    oldMessages: category.oldMessages,
    protectedMessages: category.protectedMessages,
    estimatedBytes: category.estimatedEligibleBytes
  };
}
