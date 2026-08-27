import "server-only";
import { randomUUID } from "node:crypto";
import type { GmailCleanupJobView } from "@/lib/domain/gmail-cleanup-summary";
import type { GmailCleanupCandidate } from "@/lib/providers/gmail/cleanup-candidates";

export type GmailCleanupStoredCandidate = GmailCleanupCandidate & { groupIndex: number };

export type GmailCleanupJob = Omit<
  GmailCleanupJobView,
  "id" | "undoAvailable" | "expiresAt" | "confirmationExpiresAt"
> & {
  id: string;
  userId: string;
  scanId: string;
  groupIndices: number[];
  apiCandidates: GmailCleanupStoredCandidate[];
  validatedAt: number;
  confirmationExpiresAt: number;
  createdAt: number;
  expiresAt: number;
};

const undoTtlMs = 10 * 60 * 1000;
export const gmailCleanupConfirmationTtlMs = 2 * 60 * 1000;

const globalStore = globalThis as unknown as {
  organizinboxGmailCleanupJobs?: Map<string, GmailCleanupJob>;
  organizinboxGmailCleanupOperations?: Map<string, ActiveCleanupOperation>;
};

type ActiveCleanupOperation = {
  promise: Promise<unknown>;
  onDuplicate?: () => void;
};

export const gmailCleanupJobs = globalStore.organizinboxGmailCleanupJobs ?? new Map<string, GmailCleanupJob>();
globalStore.organizinboxGmailCleanupJobs = gmailCleanupJobs;
const activeCleanupOperations =
  globalStore.organizinboxGmailCleanupOperations ?? new Map<string, ActiveCleanupOperation>();
globalStore.organizinboxGmailCleanupOperations = activeCleanupOperations;

export function createGmailCleanupJob(
  input: Omit<GmailCleanupJob, "id" | "createdAt" | "expiresAt" | "validatedAt" | "confirmationExpiresAt">
) {
  const now = Date.now();
  const job: GmailCleanupJob = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    validatedAt: now,
    confirmationExpiresAt: now + gmailCleanupConfirmationTtlMs,
    expiresAt: now + undoTtlMs
  };
  gmailCleanupJobs.set(job.id, job);
  return job;
}

export function getGmailCleanupJob(userId: string, jobId: string) {
  const job = gmailCleanupJobs.get(jobId);
  if (!job || job.userId !== userId) return undefined;
  if (job.expiresAt < Date.now()) {
    gmailCleanupJobs.delete(jobId);
    return undefined;
  }
  return job;
}

export function updateGmailCleanupJob(job: GmailCleanupJob, patch: Partial<GmailCleanupJob>) {
  const current = gmailCleanupJobs.get(job.id) ?? job;
  const updated = { ...current, ...patch };
  gmailCleanupJobs.set(updated.id, updated);
  return updated;
}

export function invalidateGmailCleanupPreview(userId: string, jobId: string) {
  const job = getGmailCleanupJob(userId, jobId);
  if (!job) return "missing" as const;
  if (
    activeCleanupOperations.has(`trash:${job.id}`) ||
    job.status === "running" ||
    job.status === "undoing" ||
    job.mutationStarted
  ) {
    return "mutation_started" as const;
  }
  if (job.status === "completed" || job.status === "partial" || job.status === "undone") {
    return "complete" as const;
  }

  gmailCleanupJobs.delete(job.id);
  return "invalidated" as const;
}

export function runOrJoinGmailCleanupOperation<T>(
  key: string,
  operation: () => Promise<T>,
  onDuplicate?: () => void
): { promise: Promise<T>; duplicate: boolean } {
  const active = activeCleanupOperations.get(key);
  if (active) {
    active.onDuplicate?.();
    return { promise: active.promise as Promise<T>, duplicate: true };
  }

  const promise = Promise.resolve().then(operation);
  const entry: ActiveCleanupOperation = { promise, onDuplicate };
  activeCleanupOperations.set(key, entry);
  void promise.then(
    () => clearActiveCleanupOperation(key, entry),
    () => clearActiveCleanupOperation(key, entry)
  );
  return { promise, duplicate: false };
}

export function incrementGmailCleanupDuplicateSubmission(
  jobId: string,
  operation: "trash" | "undo"
) {
  const job = gmailCleanupJobs.get(jobId);
  if (!job) return;
  updateGmailCleanupJob(job, {
    duplicateSubmissionsBlocked: {
      ...job.duplicateSubmissionsBlocked,
      [operation]: job.duplicateSubmissionsBlocked[operation] + 1
    }
  });
}

export function clearGmailCleanupJobsForUser(userId: string) {
  for (const [jobId, job] of gmailCleanupJobs.entries()) {
    if (job.userId === userId) gmailCleanupJobs.delete(jobId);
  }
}

export function serializeGmailCleanupJob(job: GmailCleanupJob): GmailCleanupJobView {
  const undoAvailable =
    job.status === "completed" &&
    job.attemptedCount > 0 &&
    job.verifiedCount === job.attemptedCount &&
    job.failedCount === 0 &&
    job.uncertainCount === 0 &&
    job.expiresAt >= Date.now();

  return {
    id: job.id,
    status: job.status,
    diagnosticResult: job.diagnosticResult,
    groupDisplayName: job.groupDisplayName,
    groupSecondaryLabel: job.groupSecondaryLabel,
    criteria: job.criteria,
    requestedCount: job.requestedCount,
    reportReadyCount: job.reportReadyCount,
    resolvedCount: job.resolvedCount,
    excludedMessageCount: job.excludedMessageCount,
    exclusionCounts: { ...job.exclusionCounts },
    eligibleSenderGroupCount: job.eligibleSenderGroupCount,
    selectedSenderGroupCount: job.selectedSenderGroupCount,
    eligibleSelectedSenderGroupCount: job.eligibleSelectedSenderGroupCount,
    selectedReadyCount: job.selectedReadyCount,
    selectedReviewExcludedCount: job.selectedReviewExcludedCount,
    selectedProtectedExcludedCount: job.selectedProtectedExcludedCount,
    contributingSenderGroupCount: job.contributingSenderGroupCount,
    largestContribution: job.largestContribution,
    smallestContribution: job.smallestContribution,
    senderGroupResolution: {
      ...job.senderGroupResolution,
      failureReasonCounts: { ...job.senderGroupResolution.failureReasonCounts },
      providerFailureReasonCounts: job.senderGroupResolution.providerFailureReasonCounts
        ? { ...job.senderGroupResolution.providerFailureReasonCounts }
        : undefined,
      failedGroups: job.senderGroupResolution.failedGroups.map((group) => ({ ...group }))
    },
    mutationMethod: job.mutationMethod,
    mutationStarted: job.mutationStarted,
    benchmarkOnly: job.benchmarkOnly,
    batchApiResult: job.batchApiResult,
    attemptedCount: job.attemptedCount,
    verifiedCount: job.verifiedCount,
    failedCount: job.failedCount,
    uncertainCount: job.uncertainCount,
    verifiedTrashCount: job.verifiedTrashCount,
    reportMarkedStale: job.reportMarkedStale,
    candidateResolutionMs: job.candidateResolutionMs,
    previewSafetyCheckMs: job.previewSafetyCheckMs,
    finalSafetyRecheckMs: job.finalSafetyRecheckMs,
    batchMutationMs: job.batchMutationMs,
    verificationMs: job.verificationMs,
    totalCleanupMs: job.totalCleanupMs,
    previewRequestProfile: cloneProfile(job.previewRequestProfile),
    confirmationRequestProfile: cloneProfile(job.confirmationRequestProfile),
    undoRequestProfile: cloneProfile(job.undoRequestProfile),
    requestProfile: cloneProfile(job.requestProfile),
    estimatedThousandMessageSafetyMs: job.estimatedThousandMessageSafetyMs,
    estimatedThousandMessageQuotaUnits: job.estimatedThousandMessageQuotaUnits,
    undoAttemptedCount: job.undoAttemptedCount,
    undoVerifiedCount: job.undoVerifiedCount,
    undoFailedCount: job.undoFailedCount,
    undoUncertainCount: job.undoUncertainCount,
    undoFallbackVerificationCount: job.undoFallbackVerificationCount,
    untrashMs: job.untrashMs,
    undoVerificationMs: job.undoVerificationMs,
    totalUndoMs: job.totalUndoMs,
    operationStates: { ...job.operationStates },
    duplicateSubmissionsBlocked: { ...job.duplicateSubmissionsBlocked },
    shadowVerification: job.shadowVerification ? { ...job.shadowVerification } : undefined,
    undoAvailable,
    confirmationExpiresAt: job.confirmationExpiresAt,
    error: job.error,
    expiresAt: job.expiresAt,
    completedAt: job.completedAt
  };
}

function clearActiveCleanupOperation(key: string, entry: ActiveCleanupOperation) {
  if (activeCleanupOperations.get(key) === entry) activeCleanupOperations.delete(key);
}

function cloneProfile(profile: GmailCleanupJobView["requestProfile"]) {
  return { ...profile, requests: { ...profile.requests } };
}
