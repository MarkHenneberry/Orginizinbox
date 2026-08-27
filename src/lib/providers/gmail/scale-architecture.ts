export const gmailScaleQuotaUnits = {
  getProfile: 1,
  historyList: 2,
  messagesList: 5,
  messagesGet: 20,
  batchModify: 50,
  untrash: 5
} as const;

export const gmailScalePolicy = {
  providerUnitsPerUserMinute: 6_000,
  reserveUnits: 1_500,
  workingUnitsPerMinute: 4_500,
  mutationChunkSize: 250,
  listPageSize: 500,
  maxGetFallbackPerChunk: 10,
  bulkTrashRemovalUndoEnabled: false
} as const;

export type GmailHistoryPage = {
  history?: Array<{
    labelsAdded?: Array<{
      message?: { id?: string };
      labelIds?: string[];
    }>;
  }>;
  nextPageToken?: string;
};

export type GmailReconciliation = {
  verifiedIds: string[];
  unresolvedIds: string[];
};

export type GmailHistoryAttemptResult = GmailReconciliation & {
  historyUnavailable: boolean;
};

export type GmailScaleChunkResult = {
  attemptedCount: number;
  verifiedCount: number;
  failedCount: number;
  uncertainCount: number;
};

export function chunkUniqueGmailIds(ids: readonly string[], size = gmailScalePolicy.mutationChunkSize): string[][] {
  if (!Number.isInteger(size) || size < 1 || size > 1_000) {
    throw new Error("Gmail scale chunk size must be between 1 and 1000.");
  }
  if (ids.some((id) => !id)) throw new Error("Gmail scale input contains an invalid message ID.");
  if (new Set(ids).size !== ids.length) throw new Error("Gmail scale input contains duplicate message IDs.");

  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) chunks.push(ids.slice(index, index + size));
  return chunks;
}

export function reconcileTrashHistory(targetIds: readonly string[], pages: readonly GmailHistoryPage[]): GmailReconciliation {
  const targets = new Set(targetIds);
  const verified = new Set<string>();
  for (const page of pages) {
    for (const record of page.history ?? []) {
      for (const addition of record.labelsAdded ?? []) {
        const id = addition.message?.id;
        const labels = new Set((addition.labelIds ?? []).map((label) => label.toUpperCase()));
        if (id && targets.has(id) && labels.has("TRASH")) verified.add(id);
      }
    }
  }
  return partitionTargets(targetIds, verified);
}

export function reconcileTrashHistoryAttempt(
  targetIds: readonly string[],
  input: { status: number; pages?: readonly GmailHistoryPage[] }
): GmailHistoryAttemptResult {
  if (input.status === 404) {
    return { verifiedIds: [], unresolvedIds: [...targetIds], historyUnavailable: true };
  }
  if (input.status < 200 || input.status >= 300) {
    throw new Error("Gmail history verification did not return a usable response.");
  }
  return { ...reconcileTrashHistory(targetIds, input.pages ?? []), historyUnavailable: false };
}

export function reconcileTrashList(targetIds: readonly string[], listedTrashIds: readonly string[]): GmailReconciliation {
  const targets = new Set(targetIds);
  const verified = new Set(listedTrashIds.filter((id) => targets.has(id)));
  return partitionTargets(targetIds, verified);
}

export function selectBoundedGetFallback(unresolvedIds: readonly string[], limit = gmailScalePolicy.maxGetFallbackPerChunk) {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Gmail fallback limit must be a non-negative integer.");
  return {
    fallbackIds: unresolvedIds.slice(0, limit),
    heldUncertainCount: Math.max(0, unresolvedIds.length - limit)
  };
}

export function summarizeScaleProgress(results: readonly GmailScaleChunkResult[]) {
  const summary = results.reduce(
    (total, result) => {
      assertScaleAccounting(result);
      total.attemptedCount += result.attemptedCount;
      total.verifiedCount += result.verifiedCount;
      total.failedCount += result.failedCount;
      total.uncertainCount += result.uncertainCount;
      return total;
    },
    { attemptedCount: 0, verifiedCount: 0, failedCount: 0, uncertainCount: 0 }
  );
  return { ...summary, canContinue: summary.failedCount === 0 && summary.uncertainCount === 0 };
}

export function assertScaleAccounting(result: GmailScaleChunkResult) {
  if (result.attemptedCount !== result.verifiedCount + result.failedCount + result.uncertainCount) {
    throw new Error("Invalid scalable Gmail cleanup accounting.");
  }
}

export function estimateScalableGmailCleanup(messageCount: number, options: {
  personalListPagesPerChunk?: number;
  historyListRequestsPerChunk?: number;
  fallbackListRequests?: number;
  fallbackGetRequests?: number;
  retryUnits?: number;
} = {}) {
  assertMessageCount(messageCount);
  const chunks = Math.ceil(messageCount / gmailScalePolicy.mutationChunkSize);
  const personalListPagesPerChunk = options.personalListPagesPerChunk ?? 1;
  assertNonNegativeInteger(personalListPagesPerChunk, "Personal list pages per chunk");
  const safetyListRequests = chunks * personalListPagesPerChunk;
  const historyListRequests = chunks * (options.historyListRequestsPerChunk ?? 1);
  const fallbackListRequests = options.fallbackListRequests ?? 0;
  const fallbackGetRequests = options.fallbackGetRequests ?? 0;
  const retryUnits = options.retryUnits ?? 0;
  const safety = safetyListRequests * gmailScaleQuotaUnits.messagesList;
  const mutation = chunks * gmailScaleQuotaUnits.batchModify;
  const verification =
    chunks * gmailScaleQuotaUnits.getProfile +
    historyListRequests * gmailScaleQuotaUnits.historyList +
    fallbackListRequests * gmailScaleQuotaUnits.messagesList +
    fallbackGetRequests * gmailScaleQuotaUnits.messagesGet;
  const beforeUndo = safety + mutation + verification + retryUnits;
  const individualUndo = messageCount * gmailScaleQuotaUnits.untrash;
  return {
    messageCount,
    chunks,
    personalListPagesPerChunk,
    safetyListRequests,
    historyListRequests,
    fallbackListRequests,
    fallbackGetRequests,
    retryUnits,
    safety,
    mutation,
    verification,
    beforeUndo,
    individualUndo,
    includingIndividualUndo: beforeUndo + individualUndo,
    cleanupPlanningWindows: quotaPlanningWindows(beforeUndo),
    undoPlanningWindows: quotaPlanningWindows(individualUndo)
  };
}

export function estimateCurrentPerMessageArchitecture(messageCount: number) {
  assertMessageCount(messageCount);
  return 50 * messageCount + 45;
}

export function quotaPlanningWindows(units: number, workingBudget = gmailScalePolicy.workingUnitsPerMinute) {
  if (!Number.isFinite(units) || units < 0 || !Number.isFinite(workingBudget) || workingBudget <= 0) {
    throw new Error("Quota planning values must be non-negative and finite.");
  }
  return units === 0 ? 0 : Math.ceil(units / workingBudget);
}

export class GmailQuotaBudget {
  private consumed = 0;

  constructor(readonly workingUnits: number = gmailScalePolicy.workingUnitsPerMinute) {
    if (!Number.isInteger(workingUnits) || workingUnits <= 0) throw new Error("Gmail working quota must be positive.");
  }

  canConsume(units: number) {
    assertQuotaSpend(units);
    return this.consumed + units <= this.workingUnits;
  }

  consume(units: number) {
    if (!this.canConsume(units)) return false;
    this.consumed += units;
    return true;
  }

  get snapshot() {
    return { consumedUnits: this.consumed, remainingUnits: this.workingUnits - this.consumed };
  }
}

export function formatGmailScaleDevelopmentSummary(input: {
  messagesTested: number;
  xGmMsgidAvailable: number;
  apiIdMatches: number;
  mismatches: number;
  safetyBenchmark?: {
    targets: number;
    restListPages: number;
    restSafetyUnits: number;
    imapExactRecheckSupported: boolean;
    imapComparisonMismatches: number;
    personalListPages: number;
  };
  verificationBenchmark?: {
    historyPagesPerChunk: number;
    historyPagesMeasured: boolean;
    trashListFallbackPages: number;
    getFallbacks: number;
  };
}) {
  const counts = [100, 500, 1_000, 5_000];
  const benchmark = input.safetyBenchmark;
  const verification = input.verificationBenchmark;
  const lines = [
    "ORGANIZINBOX DEV SCALE ARCHITECTURE",
    "",
    "ID bridge",
    `Messages tested: ${input.messagesTested}`,
    `X-GM-MSGID available: ${input.xGmMsgidAvailable}`,
    `API ID matches: ${input.apiIdMatches}`,
    `Mismatches: ${input.mismatches}`,
    "",
    "Safety benchmark",
    `Targets: ${benchmark?.targets.toLocaleString("en-US") ?? "not measured"}`,
    `REST list pages: ${benchmark?.restListPages.toLocaleString("en-US") ?? "not measured"}`,
    `REST safety units: ${benchmark?.restSafetyUnits.toLocaleString("en-US") ?? "not measured"}`,
    `IMAP exact recheck: ${benchmark ? (benchmark.imapExactRecheckSupported ? "supported" : "not supported") : "not measured"}`,
    `IMAP comparison mismatches: ${benchmark?.imapComparisonMismatches.toLocaleString("en-US") ?? "not measured"}`,
    `Personal/category list pages: ${benchmark?.personalListPages.toLocaleString("en-US") ?? "not measured"}`,
    "",
    "Current architecture estimate",
    ...counts.map((count) => `${count.toLocaleString("en-US")}: ${estimateCurrentPerMessageArchitecture(count).toLocaleString("en-US")} units`),
    "",
    "Updated estimated cleanup units",
    ...counts.map((count) => `${count.toLocaleString("en-US")}: ${estimateScalableGmailCleanup(count).beforeUndo.toLocaleString("en-US")} units`),
    "",
    "Verification",
    "Chosen strategy: history + list + bounded unresolved get fallback",
    `History pages per 250 targets: ${verification?.historyPagesPerChunk ?? 1} ${verification?.historyPagesMeasured ? "measured" : "estimated"}`,
    `Trash-list fallback pages: ${verification?.trashListFallbackPages ?? 0} ${verification ? "measured" : "expected"}`,
    `Get fallbacks: ${verification?.getFallbacks ?? 0} ${verification ? "measured" : "expected"}; hard maximum 10 per chunk`,
    "",
    "Mutation",
    `Chunk size recommendation: ${gmailScalePolicy.mutationChunkSize}`,
    "",
    "Undo",
    `1,000 estimated units: ${estimateScalableGmailCleanup(1_000).individualUndo.toLocaleString("en-US")}`,
    "Recommended strategy: paced individual untrash; bulk TRASH-label removal remains disabled",
    "",
    "Quota budget",
    `Per-user reference: ${gmailScalePolicy.providerUnitsPerUserMinute.toLocaleString("en-US")}/min`,
    `Safety reserve: ${gmailScalePolicy.reserveUnits.toLocaleString("en-US")}`,
    `Working budget: ${gmailScalePolicy.workingUnitsPerMinute.toLocaleString("en-US")}/min`
  ];
  return lines.join("\n");
}

function partitionTargets(targetIds: readonly string[], verified: ReadonlySet<string>): GmailReconciliation {
  return {
    verifiedIds: targetIds.filter((id) => verified.has(id)),
    unresolvedIds: targetIds.filter((id) => !verified.has(id))
  };
}

function assertMessageCount(messageCount: number) {
  if (!Number.isInteger(messageCount) || messageCount < 1) throw new Error("Message count must be a positive integer.");
}

function assertQuotaSpend(units: number) {
  if (!Number.isInteger(units) || units < 0) throw new Error("Quota spend must be a non-negative integer.");
}

function assertNonNegativeInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
}
