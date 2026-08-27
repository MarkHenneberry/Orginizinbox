import "server-only";
import { randomUUID } from "node:crypto";
import { GmailProvider } from "@/lib/providers/gmail/provider";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { createProgress, nextExpiry, setLiveScan, type BenchmarkLimit, type BenchmarkProgress } from "@/lib/server/live-scan-store";

export const benchmarkLimits = [5000, 10000, 25000, 50000, 100000, "full"] as const;
export const normalGmailScanDefaults = {
  limit: "full" as const,
  batchSize: 1000
};

export function assertDevBenchmarkEnabled(enabled: boolean) {
  if (process.env.NODE_ENV === "production" || !enabled) {
    throw new Error("Gmail benchmark is disabled.");
  }
}

export function isBenchmarkLimit(value: unknown): value is BenchmarkLimit {
  return benchmarkLimits.includes(value as BenchmarkLimit);
}

export function createGmailBenchmarkSession(input: {
  userId: string;
  providerConnectionId?: string;
  limit: BenchmarkLimit;
  batchSize: number;
}) {
  const cancel = new AbortController();
  const progress = createProgress({
    scanId: randomUUID(),
    limit: input.limit,
    batchSize: input.batchSize
  });

  setLiveScan(input.userId, {
    progress,
    cancel,
    expiresAt: nextExpiry()
  });

  void runGmailBenchmark({
    userId: input.userId,
    providerConnectionId: input.providerConnectionId,
    limit: input.limit,
    batchSize: input.batchSize,
    progress,
    signal: cancel.signal
  });

  return progress;
}

export function createGmailScanSession(input: {
  userId: string;
  providerConnectionId?: string;
}) {
  return createGmailBenchmarkSession({
    userId: input.userId,
    providerConnectionId: input.providerConnectionId,
    ...normalGmailScanDefaults
  });
}

async function runGmailBenchmark(input: {
  userId: string;
  providerConnectionId?: string;
  limit: BenchmarkLimit;
  batchSize: number;
  progress: BenchmarkProgress;
  signal: AbortSignal;
}) {
  const started = performance.now();
  let protectionClassificationMs = 0;
  let aggregationMs = 0;
  let subjectProtectionMs = 0;

  try {
    const activeConnection = await getActiveGmailConnection(input.userId, input.providerConnectionId);
    if (!activeConnection) {
      throw new Error("No active Gmail connection is available.");
    }

    const provider = new GmailProvider(activeConnection.accessToken, activeConnection.accountEmail);
    const conversationIndexStarted = performance.now();
    const participatedConversationIds = await provider.scanParticipatedConversationIds({
      batchSize: input.batchSize,
      signal: input.signal
    });
    input.progress.conversationIndexMs = Math.round(performance.now() - conversationIndexStarted);
    input.progress.peakParticipatedConversationCount = participatedConversationIds.size;
    const aggregator = new StreamingReportAggregator({
      participatedConversationIds,
      includeDiagnostics: process.env.NODE_ENV !== "production"
    });
    let connectedAt: number | undefined;
    const numericLimit = input.limit === "full" ? "full" : input.limit;
    const scanConnectionStarted = performance.now();

    for await (const batch of provider.scanMetadata({
      batchSize: input.batchSize,
      limit: numericLimit,
      signal: input.signal,
      onConnected: ({ mailboxPath, mailboxExists }) => {
        connectedAt = performance.now();
        input.progress.connectionMs = Math.round(connectedAt - scanConnectionStarted);
        input.progress.mailboxPath = mailboxPath;
        input.progress.mailboxExists = mailboxExists;
      }
    })) {
      const timing = aggregator.processBatch(batch.records);
      protectionClassificationMs += timing.protectionClassificationMs;
      aggregationMs += timing.aggregationMs;
      subjectProtectionMs += batch.subjectProtectionMs ?? 0;
      input.progress.processed += batch.records.length;
      input.progress.mailboxExists = batch.mailboxExists ?? input.progress.mailboxExists;
      input.progress.aggregationMs = Math.round(aggregationMs);
      input.progress.protectionClassificationMs = Math.round(protectionClassificationMs);
      input.progress.subjectProtectionMs = Math.round(subjectProtectionMs);
      input.progress.metadataMs = Math.round(
        performance.now() -
          (connectedAt ?? scanConnectionStarted) -
          aggregationMs -
          protectionClassificationMs -
          subjectProtectionMs
      );
      input.progress.approxMemoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    }

    input.progress.status = "completed";
    input.progress.completedAt = Date.now();
    input.progress.durationMs = Math.round(performance.now() - started);
    input.progress.metadataMs = Math.max(
      0,
      Math.round(
        (input.progress.durationMs ?? 0) -
          (input.progress.connectionMs ?? 0) -
          (input.progress.conversationIndexMs ?? 0) -
          protectionClassificationMs -
          aggregationMs -
          subjectProtectionMs
      )
    );
    input.progress.protectionClassificationMs = Math.round(protectionClassificationMs);
    input.progress.subjectProtectionMs = Math.round(subjectProtectionMs);
    input.progress.aggregationMs = Math.round(aggregationMs);
    input.progress.messagesPerSecond = throughput(input.progress.processed, input.progress.durationMs);
    input.progress.messagesPerMinute = Math.round((input.progress.messagesPerSecond ?? 0) * 60);

    setLiveScan(input.userId, {
      progress: input.progress,
      report: aggregator.snapshot("gmail", false),
      participatedConversationIds,
      cancel: new AbortController(),
      expiresAt: nextExpiry()
    });
  } catch (error) {
    input.progress.completedAt = Date.now();
    input.progress.durationMs = Math.round(performance.now() - started);
    if (error instanceof DOMException && error.name === "AbortError") {
      input.progress.status = "cancelled";
      input.progress.notes.push("Benchmark cancelled by user.");
      return;
    }
    input.progress.status = "failed";
    input.progress.errors.push(safeErrorMessage(error));
  }
}

function throughput(processed: number, durationMs?: number) {
  if (!durationMs || durationMs <= 0) return 0;
  return Math.round((processed / (durationMs / 1000)) * 100) / 100;
}

function safeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Gmail benchmark failed.";
}
