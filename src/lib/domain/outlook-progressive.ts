import { isAutoSubmitted } from "./classification";
import { assessMessage } from "./recommendations";
import { StreamingReportAggregator } from "./streaming-aggregator";
import type { InboxReport, NormalizedMailboxRecord } from "./types";

export type OutlookVerification = { candidates: number; checked: number; failed: number; status: "running" | "complete" | "unavailable" };
export type OutlookProgressiveState = {
  assessedAt: number;
  records: Array<{ record: NormalizedMailboxRecord; verification?: "pending" | "verified" | "failed" }>;
  queue: number[];
};

export function createOutlookProgressiveState(records: NormalizedMailboxRecord[], participated: ReadonlySet<string>, now: number): OutlookProgressiveState {
  const context = { now: new Date(now), participatedConversationIds: participated };
  const counts = new Map<string, number>();
  const labeled = new Set<string>();
  for (const record of records) {
    counts.set(record.senderAddress, (counts.get(record.senderAddress) ?? 0) + 1);
    if (record.userLabels?.length) labeled.add(record.senderAddress);
  }
  const state: OutlookProgressiveState = { assessedAt: now, records: [], queue: [] };
  for (const original of records) {
    const record = { ...original, listId: undefined, hasListUnsubscribe: false, precedence: undefined, autoSubmitted: undefined };
    const assessed = assessMessage(record, context);
    const candidate = !assessed.isProtected && ["old", "very_old"].includes(assessed.ageBand) &&
      !labeled.has(record.senderAddress) && (counts.get(record.senderAddress) ?? 0) >= 3;
    if (candidate) state.queue.push(state.records.length);
    state.records.push({ record, ...(candidate ? { verification: "pending" as const } : {}) });
  }
  state.queue.sort((a, b) => (counts.get(records[b].senderAddress) ?? 0) - (counts.get(records[a].senderAddress) ?? 0) ||
    new Date(records[a].receivedAt).getTime() - new Date(records[b].receivedAt).getTime() || a - b);
  return state;
}

export function applyOutlookEvidence(state: OutlookProgressiveState, index: number, evidence: Pick<NormalizedMailboxRecord, "listId" | "hasListUnsubscribe" | "precedence" | "autoSubmitted"> | undefined) {
  const target = state.records[index];
  if (!target || target.verification !== "pending") return;
  target.verification = evidence ? "verified" : "failed";
  if (!evidence) return;
  // Classification depends on presence and enums, never raw header values.
  Object.assign(target.record, {
    listId: evidence.listId ? "verified" : undefined,
    hasListUnsubscribe: evidence.hasListUnsubscribe === true,
    precedence: ["bulk", "list"].includes(evidence.precedence ?? "") ? evidence.precedence : undefined,
    autoSubmitted: isAutoSubmitted(evidence.autoSubmitted) ? "auto-generated" : undefined
  });
}

export function snapshotOutlookProgressive(state: OutlookProgressiveState, participated: ReadonlySet<string>, includeDiagnostics = false): InboxReport {
  const aggregator = new StreamingReportAggregator({ now: new Date(state.assessedAt), participatedConversationIds: participated, includeDiagnostics });
  const pending = new Map<string, number>();
  for (const entry of state.records) {
    aggregator.process({ ...entry.record, receivedAt: new Date(entry.record.receivedAt) });
    if (entry.verification === "pending") pending.set(entry.record.senderAddress, (pending.get(entry.record.senderAddress) ?? 0) + 1);
  }
  const report = aggregator.snapshot("microsoft", false);
  for (const sender of report.senders) sender.pendingVerificationCount = pending.get(sender.senderKey) ?? 0;
  return report;
}

export function outlookVerification(state: OutlookProgressiveState, unavailable = false): OutlookVerification {
  const pending = state.records.filter(entry => entry.verification === "pending").length;
  return { candidates: state.queue.length, checked: state.queue.length - pending,
    failed: state.records.filter(entry => entry.verification === "failed").length,
    status: unavailable ? "unavailable" : pending ? "running" : "complete" };
}

export function verifiedOutlookMessageIds(state: OutlookProgressiveState, report: InboxReport, participated: ReadonlySet<string>) {
  const suggested = new Set(report.senders.filter(sender => sender.cleanupCandidateCount > 0).map(sender => sender.senderKey));
  return state.records.filter(entry => entry.verification === "verified" && suggested.has(entry.record.senderAddress) &&
    assessMessage({ ...entry.record, receivedAt: new Date(entry.record.receivedAt) }, {
      now: new Date(state.assessedAt), participatedConversationIds: participated
    }).eligibleForCleanup).map(entry => entry.record.providerMessageId);
}
