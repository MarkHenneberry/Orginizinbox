import "server-only";
import type { InboxReport } from "@/lib/domain/types";
import type { GmailScalableCleanupTarget } from "@/lib/providers/gmail/scalable-targets";

export type BenchmarkLimit = 5000 | 10000 | 25000 | 50000 | 100000 | "full";
export type BenchmarkStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export type BenchmarkProgress = {
  scanId: string;
  provider: "gmail";
  status: BenchmarkStatus;
  limit: BenchmarkLimit;
  batchSize: number;
  processed: number;
  mailboxPath?: string;
  mailboxExists?: number;
  startedAt: number;
  completedAt?: number;
  connectionMs?: number;
  conversationIndexMs?: number;
  metadataMs?: number;
  subjectProtectionMs?: number;
  protectionClassificationMs?: number;
  aggregationMs?: number;
  durationMs?: number;
  messagesPerSecond?: number;
  messagesPerMinute?: number;
  approxMemoryMb?: number;
  peakParticipatedConversationCount?: number;
  duplicateStartCount: number;
  errors: string[];
  notes: string[];
};

export type LiveScanSession = {
  progress: BenchmarkProgress;
  report?: InboxReport;
  participatedConversationIds?: Set<string>;
  cancel: AbortController;
  expiresAt: number;
  reportStale?: boolean;
  gmailUidValidity?: string;
  scalableCleanupTargets?: GmailScalableCleanupTarget[];
};

const globalStore = globalThis as unknown as {
  organizinboxLiveScans?: Map<string, LiveScanSession>;
  organizinboxExpiredLiveScans?: Set<string>;
};

const ttlMs = 60 * 60 * 1000;

export const liveScanStore = globalStore.organizinboxLiveScans ?? new Map<string, LiveScanSession>();
globalStore.organizinboxLiveScans = liveScanStore;
const expiredLiveScans = globalStore.organizinboxExpiredLiveScans ?? new Set<string>();
globalStore.organizinboxExpiredLiveScans = expiredLiveScans;

export function setLiveScan(userId: string, session: LiveScanSession) {
  expiredLiveScans.delete(userId);
  liveScanStore.set(userId, session);
}

export function getLiveScan(userId: string): LiveScanSession | undefined {
  const session = liveScanStore.get(userId);
  if (!session) return undefined;
  if (session.expiresAt < Date.now()) {
    liveScanStore.delete(userId);
    expiredLiveScans.add(userId);
    return undefined;
  }
  session.expiresAt = nextExpiry();
  liveScanStore.set(userId, session);
  return session;
}

export function clearLiveScan(userId: string) {
  const session = liveScanStore.get(userId);
  session?.cancel.abort();
  liveScanStore.delete(userId);
  expiredLiveScans.delete(userId);
}

export function reuseRunningLiveScan(userId: string) {
  const session = getLiveScan(userId);
  if (!session || session.progress.status !== "running") return undefined;
  session.progress.duplicateStartCount += 1;
  liveScanStore.set(userId, session);
  return session;
}

export function hasExpiredLiveScan(userId: string) {
  return expiredLiveScans.has(userId);
}

export function markLiveReportStale(userId: string) {
  const session = getLiveScan(userId);
  if (!session) return;
  session.reportStale = true;
  session.progress.notes = [...session.progress.notes, "Inbox changed since this report was generated. Run a fresh scan before another cleanup."];
  liveScanStore.set(userId, session);
}

export function createProgress(input: {
  scanId: string;
  limit: BenchmarkLimit;
  batchSize: number;
}): BenchmarkProgress {
  return {
    scanId: input.scanId,
    provider: "gmail",
    status: "running",
    limit: input.limit,
    batchSize: input.batchSize,
    processed: 0,
    startedAt: Date.now(),
    duplicateStartCount: 0,
    errors: [],
    notes: []
  };
}

export function nextExpiry() {
  return Date.now() + ttlMs;
}

export const transientReportStore = {
  get: getLiveScan,
  set: setLiveScan,
  touch: getLiveScan,
  delete: clearLiveScan,
  hasActiveReport(userId: string) {
    const session = getLiveScan(userId);
    return Boolean(session?.report && session.progress.status === "completed");
  }
};

export function serializeBenchmark(progress: BenchmarkProgress) {
  return {
    scanId: progress.scanId,
    provider: progress.provider,
    status: progress.status,
    limit: progress.limit,
    batchSize: progress.batchSize,
    processed: progress.processed,
    mailboxExists: progress.mailboxExists,
    startedAt: progress.startedAt,
    completedAt: progress.completedAt,
    connectionMs: progress.connectionMs,
    conversationIndexMs: progress.conversationIndexMs,
    metadataMs: progress.metadataMs,
    subjectProtectionMs: progress.subjectProtectionMs,
    protectionClassificationMs: progress.protectionClassificationMs,
    aggregationMs: progress.aggregationMs,
    durationMs: progress.durationMs,
    messagesPerSecond: progress.messagesPerSecond,
    messagesPerMinute: progress.messagesPerMinute,
    approxMemoryMb: progress.approxMemoryMb,
    peakParticipatedConversationCount: progress.peakParticipatedConversationCount,
    duplicateStartCount: progress.duplicateStartCount,
    errors: progress.errors,
    notes: progress.notes
  };
}

export const serializeScanProgress = serializeBenchmark;
