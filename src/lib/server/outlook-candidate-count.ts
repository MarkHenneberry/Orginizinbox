import "server-only";
import { MicrosoftProvider } from "@/lib/providers/microsoft/provider";
import { classifyMessage } from "@/lib/domain/classification";
import { getAgeBand, getProtectionReasons } from "@/lib/domain/safety";
import type { NormalizedMailboxRecord } from "@/lib/domain/types";

export function isOutlookHeaderCandidate(message: NormalizedMailboxRecord, participatedConversationIds: ReadonlySet<string>, now: Date) {
  // Deliberately ignore any header evidence: this pass never assigns Suggested eligibility.
  const base = { ...message, listId: undefined, hasListUnsubscribe: false, autoSubmitted: undefined, precedence: undefined };
  const age = getAgeBand(base.receivedAt, now);
  return (age === "old" || age === "very_old") && getProtectionReasons({
    message: base, mailClass: classifyMessage(base), now, participatedConversationIds
  }).length === 0;
}

export function estimateOutlookCandidatePayload(total: number, candidates: number) {
  const base = total * (366656 / 500);
  const enrichment = candidates * ((5485436 - 366656) / 500);
  const previous = total * (5485436 / 500);
  return {
    estimatedBaseOnlyBytes: Math.round(base),
    estimatedEnrichmentBytes: Math.round(enrichment),
    estimatedTotalBytes: Math.round(base + enrichment),
    estimatedCurrentBytes: Math.round(previous),
    estimatedReductionBytes: Math.round(previous - base - enrichment),
    estimatedReductionPercentage: previous ? Math.round((previous - base - enrichment) / previous * 10000) / 100 : 0
  };
}

export async function runOutlookCandidateCount(input: {
  accessToken: string;
  signal: AbortSignal;
  coordinate: <T>(request: () => Promise<T>) => Promise<T>;
  fetchImpl?: typeof fetch;
  now?: Date;
}) {
  const provider = new MicrosoftProvider(input.accessToken, { fetchImpl: input.fetchImpl, requestCoordinator: input.coordinate });
  const now = input.now ?? new Date();
  const started = performance.now();
  let totalMessagesScanned = 0;
  let stage2Candidates = 0;
  let complete = false;
  const seen = new Set<string>();
  try {
    const participation = await provider.scanParticipatedConversationIds({ batchSize: 250, signal: input.signal });
    for await (const batch of provider.scanBaseMetadataForCandidateCount({ batchSize: 250, limit: "full", signal: input.signal })) {
      input.signal.throwIfAborted();
      for (const record of batch.records) {
        if (seen.has(record.providerMessageId)) throw new Error("Ambiguous pagination");
        seen.add(record.providerMessageId);
        totalMessagesScanned++;
        if (isOutlookHeaderCandidate(record, participation, now)) stage2Candidates++;
      }
    }
    complete = true;
  } catch { /* No raw provider errors or partial full-mailbox estimates. */ }
  finally { seen.clear(); }
  return {
    complete,
    totalMessagesScanned,
    stage2Candidates,
    candidatePercentage: totalMessagesScanned ? Math.round(stage2Candidates / totalMessagesScanned * 10000) / 100 : 0,
    payloadEstimates: complete ? estimateOutlookCandidatePayload(totalMessagesScanned, stage2Candidates) : null,
    graphRequests: provider.getScanMetrics().requests,
    mainMessagePages: provider.getScanMetrics().mainMessagePages,
    retries: provider.getScanMetrics().retries,
    durationMs: Math.round(performance.now() - started)
  };
}
