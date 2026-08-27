import {
  createGmailCleanupExclusionCounts,
  gmailCleanupExclusionReasons,
  orderCleanupResolutionGroups,
  type CleanupSenderGroup,
  type GmailCleanupCandidate,
  type GmailCleanupExclusionCounts
} from "@/lib/providers/gmail/cleanup-candidates";
import {
  createGmailProviderErrorCounts,
  type GmailProviderErrorCounts,
  type GmailProviderErrorReason
} from "@/lib/providers/gmail/api-error-classification";

export const gmailSenderGroupFailureReasons = [
  "INVALID_SENDER_IDENTITY",
  "QUERY_BUILD_FAILED",
  "PROVIDER_REQUEST_FAILED",
  "METADATA_RECHECK_FAILED",
  "GROUP_NOT_IN_REPORT",
  "GROUP_NO_LONGER_ELIGIBLE",
  "NO_SAFE_CANDIDATES",
  "OTHER_SAFE_ENUM"
] as const;

export type GmailSenderGroupFailureReason = (typeof gmailSenderGroupFailureReasons)[number];
export type GmailSenderGroupFailureCounts = Record<GmailSenderGroupFailureReason, number>;

export type GmailSenderResolutionValue = {
  candidates: GmailCleanupCandidate[];
  exclusionCounts: GmailCleanupExclusionCounts;
  excludedMessageCount: number;
  candidateResolutionMs: number;
  previewSafetyCheckMs: number;
};

export type GmailSenderGroupResolutionFailure = {
  group: CleanupSenderGroup;
  reason: GmailSenderGroupFailureReason;
  globalFailure: boolean;
  providerFailure?: GmailSenderGroupProviderFailure;
};

export type GmailSenderGroupProviderFailure = {
  stage: "messages.list" | "metadata recheck";
  reason: GmailProviderErrorReason;
  status?: number;
  retryable: boolean;
  retriesAttempted: number;
};

export type GmailSenderGroupResolutionResult = {
  candidates: Array<GmailCleanupCandidate & { groupIndex: number }>;
  exclusionCounts: GmailCleanupExclusionCounts;
  excludedMessageCount: number;
  selectedCount: number;
  attemptedCount: number;
  successfulCount: number;
  failedCount: number;
  zeroSafeCandidateCount: number;
  contributingCount: number;
  contributions: number[];
  failures: GmailSenderGroupResolutionFailure[];
  failureReasonCounts: GmailSenderGroupFailureCounts;
  providerFailureReasonCounts: GmailProviderErrorCounts;
  localFailureCount: number;
  globalProviderFailureCount: number;
  globalApplicationFailureCount: number;
  terminalGlobalApplicationFailureCount: number;
  classifiedFailureCount: number;
  failureAccountingInvariant: boolean;
  candidateResolutionMs: number;
  previewSafetyCheckMs: number;
  globalFailure: boolean;
};

export class GmailSenderGroupResolutionError extends Error {
  constructor(
    readonly reason: GmailSenderGroupFailureReason,
    readonly globalFailure: boolean,
    readonly candidateResolutionMs = 0,
    readonly previewSafetyCheckMs = 0,
    readonly providerFailure?: GmailSenderGroupProviderFailure
  ) {
    super(reason);
    this.name = "GmailSenderGroupResolutionError";
  }
}

type ResolutionState = {
  group: CleanupSenderGroup;
  target: number;
  resolvedTarget: number;
  exhausted: boolean;
  result?: GmailSenderResolutionValue;
  failure?: GmailSenderGroupResolutionFailure;
};

type ResolutionOutcome =
  | { type: "success"; state: ResolutionState; result: GmailSenderResolutionValue }
  | { type: "failure"; state: ResolutionState; error: GmailSenderGroupResolutionError }
  | { type: "skipped"; state: ResolutionState };

export async function resolveGmailCleanupSenderGroups(input: {
  selectedGroups: CleanupSenderGroup[];
  requestedCount: number;
  concurrency: number;
  resolveGroup: (group: CleanupSenderGroup, limit: number) => Promise<GmailSenderResolutionValue>;
}): Promise<GmailSenderGroupResolutionResult> {
  const orderedGroups = orderCleanupResolutionGroups(input.selectedGroups);
  const initialTargets = allocateTargets(orderedGroups, input.requestedCount);
  const states: ResolutionState[] = orderedGroups.map((group) => ({
    group,
    target: initialTargets.get(group.index) ?? 0,
    resolvedTarget: 0,
    exhausted: false
  }));
  const attempted = new Set<number>();
  let candidateResolutionMs = 0;
  let previewSafetyCheckMs = 0;

  while (true) {
    const pending = states.filter(
      (state) => !state.failure && state.target > 0 && state.resolvedTarget !== state.target
    );
    if (pending.length === 0) break;

    let stopScheduling = false;
    const outcomes = await mapWithConcurrency(pending, input.concurrency, async (state): Promise<ResolutionOutcome> => {
      if (stopScheduling) return { type: "skipped", state };
      attempted.add(state.group.index);
      try {
        return { type: "success", state, result: await input.resolveGroup(state.group, state.target) };
      } catch (error) {
        if (!(error instanceof GmailSenderGroupResolutionError)) throw error;
        if (error.globalFailure) stopScheduling = true;
        return { type: "failure", state, error };
      }
    });

    candidateResolutionMs += Math.max(
      0,
      ...outcomes.map((outcome) =>
        outcome.type === "success" ? outcome.result.candidateResolutionMs : outcome.type === "failure" ? outcome.error.candidateResolutionMs : 0
      )
    );
    previewSafetyCheckMs += Math.max(
      0,
      ...outcomes.map((outcome) =>
        outcome.type === "success" ? outcome.result.previewSafetyCheckMs : outcome.type === "failure" ? outcome.error.previewSafetyCheckMs : 0
      )
    );

    const globalOutcome = outcomes.find(
      (outcome): outcome is Extract<ResolutionOutcome, { type: "failure" }> =>
        outcome.type === "failure" && outcome.error.globalFailure
    );
    for (const outcome of outcomes) {
      if (outcome.type === "success") {
        outcome.state.result = outcome.result;
        outcome.state.resolvedTarget = outcome.state.target;
        outcome.state.exhausted = outcome.result.candidates.length < outcome.state.target;
      } else if (outcome.type === "failure") {
        outcome.state.result = undefined;
        outcome.state.failure = {
          group: outcome.state.group,
          reason: outcome.error.reason,
          globalFailure: outcome.error.globalFailure,
          providerFailure: outcome.error.providerFailure
        };
      }
    }
    if (globalOutcome) {
      return buildResult(
        states,
        attempted,
        candidateResolutionMs,
        previewSafetyCheckMs,
        input.selectedGroups.length,
        input.requestedCount,
        true
      );
    }

    const resolvedCount = states.reduce((total, state) => total + (state.result?.candidates.length ?? 0), 0);
    if (resolvedCount >= input.requestedCount) break;
    if (!allocateAdditionalTargets(states, input.requestedCount - resolvedCount)) break;
  }

  return buildResult(
    states,
    attempted,
    candidateResolutionMs,
    previewSafetyCheckMs,
    input.selectedGroups.length,
    input.requestedCount,
    false
  );
}

export function createGmailSenderGroupFailureCounts(): GmailSenderGroupFailureCounts {
  return Object.fromEntries(gmailSenderGroupFailureReasons.map((reason) => [reason, 0])) as GmailSenderGroupFailureCounts;
}

function buildResult(
  states: ResolutionState[],
  attempted: ReadonlySet<number>,
  candidateResolutionMs: number,
  previewSafetyCheckMs: number,
  selectedCount: number,
  requestedCount: number,
  globalFailure: boolean
): GmailSenderGroupResolutionResult {
  const successfulStates = states.filter((state) => state.result && !state.failure);
  const zeroStates = successfulStates.filter((state) => state.result?.candidates.length === 0);
  const failures = states.flatMap((state) => (state.failure ? [state.failure] : []));
  const failureReasonCounts = createGmailSenderGroupFailureCounts();
  const providerFailureReasonCounts = createGmailProviderErrorCounts();
  failures.forEach((failure) => {
    failureReasonCounts[failure.reason] += 1;
    if (failure.providerFailure) providerFailureReasonCounts[failure.providerFailure.reason] += 1;
  });
  failureReasonCounts.NO_SAFE_CANDIDATES += zeroStates.length;
  const localFailureCount = failures.filter((failure) => !failure.globalFailure).length;
  const globalProviderFailureCount = failures.filter(
    (failure) => failure.globalFailure && failure.providerFailure
  ).length;
  const globalApplicationFailureCount = failures.filter(
    (failure) => failure.globalFailure && !failure.providerFailure
  ).length;
  const terminalGlobalApplicationFailureCount = globalFailure && failures.length === 0 ? 1 : 0;
  const classifiedFailureCount =
    localFailureCount + globalProviderFailureCount + globalApplicationFailureCount + terminalGlobalApplicationFailureCount;
  const failureAccountingInvariant =
    classifiedFailureCount === failures.length + terminalGlobalApplicationFailureCount &&
    (!globalFailure || globalProviderFailureCount + globalApplicationFailureCount + terminalGlobalApplicationFailureCount > 0);
  const finalCandidates = globalFailure
    ? []
    : successfulStates
        .flatMap((state) =>
          (state.result?.candidates ?? []).map((candidate) => ({ ...candidate, groupIndex: state.group.index }))
        );
  const candidates = finalCandidates.slice(0, globalFailure ? 0 : requestedCount);
  const contributingIndices = new Set(candidates.map((candidate) => candidate.groupIndex));
  const contributions = states
    .map((state) => candidates.filter((candidate) => candidate.groupIndex === state.group.index).length)
    .filter((count) => count > 0);
  const exclusionCounts = successfulStates.reduce((total, state) => {
    for (const reason of gmailCleanupExclusionReasons) {
      total[reason] += state.result?.exclusionCounts[reason] ?? 0;
    }
    return total;
  }, createGmailCleanupExclusionCounts());

  return {
    candidates,
    exclusionCounts,
    excludedMessageCount: successfulStates.reduce(
      (total, state) => total + (state.result?.excludedMessageCount ?? 0),
      0
    ),
    selectedCount,
    attemptedCount: attempted.size,
    successfulCount: successfulStates.length,
    failedCount: failures.length,
    zeroSafeCandidateCount: zeroStates.length,
    contributingCount: contributingIndices.size,
    contributions,
    failures,
    failureReasonCounts,
    providerFailureReasonCounts,
    localFailureCount,
    globalProviderFailureCount,
    globalApplicationFailureCount,
    terminalGlobalApplicationFailureCount,
    classifiedFailureCount,
    failureAccountingInvariant,
    candidateResolutionMs: Math.round(candidateResolutionMs),
    previewSafetyCheckMs: Math.round(previewSafetyCheckMs),
    globalFailure
  };
}

function allocateTargets(groups: CleanupSenderGroup[], requestedCount: number) {
  const targets = new Map(groups.map((group) => [group.index, 0]));
  let remaining = requestedCount;
  while (remaining > 0) {
    let allocatedThisRound = false;
    for (const group of groups) {
      const target = targets.get(group.index) ?? 0;
      if (target >= group.cleanupCandidateCount) continue;
      targets.set(group.index, target + 1);
      remaining -= 1;
      allocatedThisRound = true;
      if (remaining === 0) break;
    }
    if (!allocatedThisRound) break;
  }
  return targets;
}

function allocateAdditionalTargets(states: ResolutionState[], requestedCount: number) {
  let remaining = requestedCount;
  let allocated = false;
  while (remaining > 0) {
    let allocatedThisRound = false;
    for (const state of states) {
      if (state.failure || state.exhausted || state.target >= state.group.cleanupCandidateCount) continue;
      state.target += 1;
      remaining -= 1;
      allocated = true;
      allocatedThisRound = true;
      if (remaining === 0) break;
    }
    if (!allocatedThisRound) break;
  }
  return allocated;
}

async function mapWithConcurrency<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(values[index]);
      }
    })
  );
  return results;
}
