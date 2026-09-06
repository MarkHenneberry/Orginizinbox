import "server-only";
import { randomUUID } from "node:crypto";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import { MicrosoftProvider } from "@/lib/providers/microsoft/provider";
import { OutlookImapProvider, outlookImapBatchSize } from "@/lib/providers/microsoft/imap-provider";
import {
  forceRefreshMicrosoftConnection,
  getActiveMicrosoftConnection,
  getActiveMicrosoftImapConnection,
  MicrosoftImapReconnectRequiredError
} from "@/lib/server/microsoft-connection";
import {
  acceptLiveScan,
  createProgress,
  getLiveScanExecutionContext,
  nextExpiry,
  setLiveScan,
  type BenchmarkProgress
} from "@/lib/server/live-scan-store";
import { startProviderScanWorkflow } from "@/lib/server/provider-scan-workflow-start";
import { createProviderRequestCoordinator } from "@/lib/server/provider-request-coordinator";

export const microsoftScanDefaults = {
  limit: "full" as const,
  batchSize: 250
};

export async function createMicrosoftScanSession(input: {
  userId: string;
  providerConnectionId: string;
  transport?: "graph" | "imap";
}) {
  const progress = createProgress({
    scanId: randomUUID(),
    provider: "microsoft",
    ...microsoftScanDefaults
  });
  progress.outlookTransport = input.transport ?? "graph";

  const accepted = await acceptLiveScan({
    userId: input.userId,
    providerConnectionId: input.providerConnectionId,
    session: { progress, expiresAt: nextExpiry() }
  });
  await startProviderScanWorkflow(accepted.session.progress.scanId);
  return { progress: accepted.session.progress, reused: accepted.reused };
}

export async function runMicrosoftScan(input: { scanId: string; lockOwner: string }) {
  const context = await getLiveScanExecutionContext(input.scanId);
  if (!context || context.lockOwner !== input.lockOwner || context.session.progress.provider !== "microsoft") return;
  const progress = createProgress({ scanId: input.scanId, provider: "microsoft", ...microsoftScanDefaults });
  progress.outlookTransport = context.session.progress.outlookTransport ?? "graph";
  progress.duplicateStartCount = context.session.progress.duplicateStartCount;
  await setLiveScan(context.userId, { progress, expiresAt: nextExpiry() }, "microsoft", input.lockOwner);
  if (progress.outlookTransport === "imap") {
    return executeMicrosoftImapScan({
      userId: context.userId,
      providerConnectionId: context.providerConnectionId,
      progress,
      signal: new AbortController().signal,
      lockOwner: input.lockOwner
    });
  }
  return executeMicrosoftScan({
    userId: context.userId,
    providerConnectionId: context.providerConnectionId,
    progress,
    signal: new AbortController().signal,
    lockOwner: input.lockOwner
  });
}

async function executeMicrosoftScan(input: {
  userId: string;
  providerConnectionId: string;
  progress: BenchmarkProgress;
  signal: AbortSignal;
  lockOwner: string;
}) {
  const started = performance.now();
  let protectionClassificationMs = 0;
  let aggregationMs = 0;
  let subjectProtectionMs = 0;
  let provider: MicrosoftProvider | undefined;
  input.progress.outlookTransport = "graph";

  try {
    const activeConnection = await getActiveMicrosoftConnection(input.userId, input.providerConnectionId);
    if (!activeConnection) throw new Error("Connect Microsoft before scanning Outlook.");

    provider = new MicrosoftProvider(activeConnection.accessToken, {
      refreshAccessToken: () => forceRefreshMicrosoftConnection(input.userId, input.providerConnectionId),
      requestCoordinator: createProviderRequestCoordinator(activeConnection.connection.id)
    });
    const conversationIndexStarted = performance.now();
    const participatedConversationIds = await provider.scanParticipatedConversationIds({
      batchSize: microsoftScanDefaults.batchSize,
      signal: input.signal
    });
    input.progress.conversationIndexMs = Math.round(performance.now() - conversationIndexStarted);
    input.progress.peakParticipatedConversationCount = participatedConversationIds.size;
    updateGraphProgress(input.progress, provider);

    const createAggregator = () => new StreamingReportAggregator({
      participatedConversationIds,
      includeDiagnostics: process.env.NODE_ENV !== "production"
    });
    let aggregator = createAggregator();
    const metadataStarted = performance.now();

    await provider.processMetadataWithAdaptiveFallback({
      scan: {
        ...microsoftScanDefaults,
        signal: input.signal
      },
      async onBatch(batch) {
        const timing = aggregator.processBatch(batch.records);
        protectionClassificationMs += timing.protectionClassificationMs;
        aggregationMs += timing.aggregationMs;
        subjectProtectionMs += batch.subjectProtectionMs ?? 0;
        input.progress.processed += batch.records.length;
        input.progress.metadataMs = Math.max(
          0,
          Math.round(performance.now() - metadataStarted - protectionClassificationMs - aggregationMs - subjectProtectionMs)
        );
        input.progress.protectionClassificationMs = Math.round(protectionClassificationMs);
        input.progress.aggregationMs = Math.round(aggregationMs);
        input.progress.subjectProtectionMs = Math.round(subjectProtectionMs);
        input.progress.approxMemoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
        updateGraphProgress(input.progress, provider!);
        await setLiveScan(input.userId, { progress: input.progress, expiresAt: nextExpiry() }, "microsoft", input.lockOwner);
      },
      async onFallback() {
        aggregator = createAggregator();
        input.progress.processed = 0;
        input.progress.notes.push(
          "Outlook returned an oversized or invalid metadata page. Restarted the main scan with smaller pages."
        );
        updateGraphProgress(input.progress, provider!);
        await setLiveScan(input.userId, { progress: input.progress, expiresAt: nextExpiry() }, "microsoft", input.lockOwner);
      }
    });

    input.progress.status = "completed";
    input.progress.completedAt = Date.now();
    input.progress.durationMs = Math.round(performance.now() - started);
    input.progress.messagesPerSecond = throughput(input.progress.processed, input.progress.durationMs);
    input.progress.messagesPerMinute = Math.round((input.progress.messagesPerSecond ?? 0) * 60);
    updateGraphProgress(input.progress, provider);

    const report = aggregator.snapshot("microsoft", false);
    await setLiveScan(input.userId, {
      progress: input.progress,
      report,
      participatedConversationIds,
      expiresAt: nextExpiry()
    }, "microsoft", input.lockOwner);

    if (process.env.NODE_ENV !== "production") {
      console.info("Outlook scan metrics", {
        messagesScanned: input.progress.processed,
        graphPages: input.progress.graphPages,
        graphRequests: input.progress.graphRequests,
        scanMode: input.progress.graphScanMode,
        foldersScanned: input.progress.graphFoldersScanned,
        maxConcurrentGraphRequests: input.progress.graphMaxConcurrentRequests,
        metadataRequests: input.progress.graphMetadataRequests,
        headerEnrichmentRequests: input.progress.graphHeaderEnrichmentRequests,
        messagesEnriched: input.progress.graphMessagesEnriched,
        mainMessagePageSize: input.progress.graphMainMessagePageSize,
        mainMessagePageSizes: input.progress.graphMainMessagePageSizes,
        mainMessagePages: input.progress.graphMainMessagePages,
        mainMessagePageFallbacks: input.progress.graphMainMessagePageFallbacks,
        throttleWaitMs: input.progress.graph429WaitMs,
        peakScanMemoryMb: input.progress.graphPeakScanMemoryMb,
        durationMs: input.progress.durationMs,
        messagesPerSecond: input.progress.messagesPerSecond
      });
    }
  } catch (error) {
    if (provider) updateGraphProgress(input.progress, provider);
    input.progress.completedAt = Date.now();
    input.progress.durationMs = Math.round(performance.now() - started);
    if (error instanceof DOMException && error.name === "AbortError") {
      input.progress.status = "cancelled";
      input.progress.notes.push("Outlook scan cancelled.");
      return;
    }
    input.progress.status = "failed";
    input.progress.errors.push(safeScanError(error));
    await setLiveScan(input.userId, { progress: input.progress, expiresAt: nextExpiry() }, "microsoft", input.lockOwner);
  }
}

async function executeMicrosoftImapScan(input: {
  userId: string;
  providerConnectionId: string;
  progress: BenchmarkProgress;
  signal: AbortSignal;
  lockOwner: string;
}) {
  const started = performance.now();
  let protectionClassificationMs = 0;
  let aggregationMs = 0;
  let subjectProtectionMs = 0;
  let provider: OutlookImapProvider | undefined;
  input.progress.outlookTransport = "imap";

  try {
    const activeConnection = await getActiveMicrosoftImapConnection(
      input.userId,
      input.providerConnectionId
    );
    provider = new OutlookImapProvider(activeConnection.accessToken, activeConnection.accountEmail);
    const conversationIndexStarted = performance.now();
    const participatedConversationIds = await provider.scanParticipatedConversationIds({
      batchSize: outlookImapBatchSize,
      signal: input.signal
    });
    input.progress.conversationIndexMs = Math.round(performance.now() - conversationIndexStarted);
    input.progress.peakParticipatedConversationCount = participatedConversationIds.size;

    const aggregator = new StreamingReportAggregator({
      participatedConversationIds,
      includeDiagnostics: process.env.NODE_ENV !== "production"
    });
    const metadataStarted = performance.now();
    for await (const batch of provider.scanMetadata({
      limit: microsoftScanDefaults.limit,
      batchSize: outlookImapBatchSize,
      signal: input.signal
    })) {
      const timing = aggregator.processBatch(batch.records);
      protectionClassificationMs += timing.protectionClassificationMs;
      aggregationMs += timing.aggregationMs;
      subjectProtectionMs += batch.subjectProtectionMs ?? 0;
      input.progress.processed += batch.records.length;
      input.progress.metadataMs = Math.max(
        0,
        Math.round(performance.now() - metadataStarted - protectionClassificationMs - aggregationMs - subjectProtectionMs)
      );
      input.progress.protectionClassificationMs = Math.round(protectionClassificationMs);
      input.progress.aggregationMs = Math.round(aggregationMs);
      input.progress.subjectProtectionMs = Math.round(subjectProtectionMs);
      input.progress.approxMemoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      updateImapProgress(input.progress, provider);
      await setLiveScan(input.userId, { progress: input.progress, expiresAt: nextExpiry() }, "microsoft", input.lockOwner);
    }

    input.progress.status = "completed";
    input.progress.completedAt = Date.now();
    input.progress.durationMs = Math.round(performance.now() - started);
    input.progress.messagesPerSecond = throughput(input.progress.processed, input.progress.durationMs);
    input.progress.messagesPerMinute = Math.round((input.progress.messagesPerSecond ?? 0) * 60);
    updateImapProgress(input.progress, provider);
    await setLiveScan(input.userId, {
      progress: input.progress,
      report: aggregator.snapshot("microsoft", false),
      participatedConversationIds,
      expiresAt: nextExpiry()
    }, "microsoft", input.lockOwner);
  } catch (error) {
    if (provider) updateImapProgress(input.progress, provider);
    input.progress.completedAt = Date.now();
    input.progress.durationMs = Math.round(performance.now() - started);
    if (error instanceof DOMException && error.name === "AbortError") {
      input.progress.status = "cancelled";
      input.progress.notes.push("Outlook IMAP benchmark cancelled.");
    } else {
      input.progress.status = "failed";
      input.progress.errors.push(safeImapScanError(error));
    }
    await setLiveScan(input.userId, { progress: input.progress, expiresAt: nextExpiry() }, "microsoft", input.lockOwner);
  } finally {
    await provider?.close();
  }
}

function updateGraphProgress(progress: BenchmarkProgress, provider: MicrosoftProvider) {
  const metrics = provider.getScanMetrics();
  progress.graphPages = metrics.graphPages;
  progress.graphRequests = metrics.requests;
  progress.graphScanMode = "full";
  progress.outlookTransport = "graph";
  progress.graphFoldersScanned = metrics.foldersScanned;
  progress.graphMaxConcurrentRequests = metrics.maxConcurrentRequests;
  progress.graphMetadataRequests = metrics.metadataRequests;
  progress.graphHeaderEnrichmentRequests = metrics.headerEnrichmentRequests;
  progress.graphMessagesEnriched = metrics.messagesEnriched;
  progress.graphMainMessagePageSize = metrics.mainMessagePageSize;
  progress.graphMainMessagePageSizes = metrics.mainMessagePageSizes;
  progress.graphMainMessagePages = metrics.mainMessagePages;
  progress.graphMainMessagePageFallbacks = metrics.mainMessagePageFallbacks;
  progress.graph429WaitMs = metrics.throttleWaitMs;
  progress.graphPeakScanMemoryMb = metrics.peakRetainedMemoryMb;
  progress.graphRetries = metrics.retries;
  progress.graphTokenRefreshes = metrics.tokenRefreshes;
  progress.graph401Failures = metrics.failures401;
  progress.graph403Failures = metrics.failures403;
  progress.graph429Throttles = metrics.throttles429;
  progress.graph5xxFailures = metrics.failures5xx;
  progress.graphOther4xxFailures = metrics.other4xxFailures;
  progress.graphLastOther4xxStatus = metrics.lastOther4xxStatus;
  progress.graphLastOther4xxCategory = metrics.lastOther4xxCategory;
  progress.graphLastOther4xxOperation = metrics.lastOther4xxOperation;
  progress.graphLastNonHttpFailureOperation = metrics.lastNonHttpFailureOperation;
  progress.graphLastNonHttpFailureCategory = metrics.lastNonHttpFailureCategory;
  progress.graphEvidenceAvailability = metrics.evidenceAvailability;
}

function updateImapProgress(progress: BenchmarkProgress, provider: OutlookImapProvider) {
  const metrics = provider.getScanMetrics();
  progress.outlookTransport = "imap";
  progress.imapFolders = metrics.folders;
  progress.imapMetadataBatches = metrics.metadataBatches;
  progress.imapCommands = metrics.commands;
  progress.imapRetries = metrics.retries;
  progress.imapErrors = metrics.errors;
  progress.imapPeakScanMemoryMb = metrics.peakRetainedMemoryMb;
  progress.graphEvidenceAvailability = metrics.evidenceAvailability;
}

function throughput(processed: number, durationMs?: number) {
  if (!durationMs || durationMs <= 0) return 0;
  return Math.round((processed / (durationMs / 1000)) * 100) / 100;
}

function safeScanError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Outlook could not be scanned. Try again.";
}

function safeImapScanError(error: unknown) {
  if (error instanceof MicrosoftImapReconnectRequiredError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return "Outlook IMAP benchmark cancelled.";
  return "Outlook IMAP could not be scanned. Try again.";
}
