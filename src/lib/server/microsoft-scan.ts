import "server-only";
import { createScanRequestFence } from "@/lib/server/provider-work-fence";
import { createDurableWriteGate } from "@/lib/server/durable-write-gate";
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
import { applyOutlookCollectionRecord, applyOutlookEvidence, createOutlookProgressiveState, outlookVerification, snapshotOutlookProgressive } from "@/lib/domain/outlook-progressive";
import type { NormalizedMailboxRecord } from "@/lib/domain/types";
import type { LiveScanSession } from "@/lib/server/live-scan-store";

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
  if (context.session.outlookProgressive) return advanceMicrosoftEnrichment({ ...context, lockOwner: input.lockOwner });
  const progress = createProgress({ scanId: input.scanId, provider: "microsoft", ...microsoftScanDefaults });
  progress.outlookTransport = context.session.progress.outlookTransport ?? "graph";
  if (progress.outlookTransport === "graph") progress.phase = "preparing";
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
  const writeProgress = createDurableWriteGate(5_000);
  input.progress.outlookTransport = "graph";
  let credentialResolutionMs = 0;
  let folderResolutionMs = 0;
  let sentStarted = 0;
  let coordinationMs = 0;
  let requestMs = 0;
  let progressWriteMs = 0;
  let progressWrites = 0;
  const saveProgress = async () => {
    const start = performance.now();
    try {
      await setLiveScan(input.userId, { progress: input.progress, expiresAt: nextExpiry() }, "microsoft", input.lockOwner);
    } finally {
      progressWrites += 1;
      progressWriteMs += performance.now() - start;
    }
  };

  try {
    const activeConnection = await getActiveMicrosoftConnection(input.userId, input.providerConnectionId);
    if (!activeConnection) throw new Error("Connect Microsoft before scanning Outlook.");
    credentialResolutionMs = Math.round(performance.now() - started);
    const coordinate = createProviderRequestCoordinator(activeConnection.connection.id, {
      fenceAfterClaimOnly: process.env.NODE_ENV === "production",
      beforeRequest: createScanRequestFence(input.progress.scanId, input.lockOwner, "microsoft")
    });

    provider = new MicrosoftProvider(activeConnection.accessToken, {
      refreshAccessToken: () => forceRefreshMicrosoftConnection(input.userId, input.providerConnectionId),
      requestCoordinator: async (request) => {
        const start = performance.now();
        let transportMs = 0;
        try {
          return await coordinate(async () => {
            const transportStart = performance.now();
            try { return await request(); }
            finally { transportMs += performance.now() - transportStart; }
          });
        } finally {
          requestMs += transportMs;
          coordinationMs += performance.now() - start - transportMs;
        }
      }
    });
    const conversationIndexStarted = performance.now();
    const participatedConversationIds = await provider.scanParticipatedConversationIds({
      batchSize: microsoftScanDefaults.batchSize,
      signal: input.signal,
      async onFoldersResolved() {
        folderResolutionMs = Math.round(performance.now() - conversationIndexStarted);
        input.progress.phase = "sent_conversations";
        await saveProgress();
        sentStarted = performance.now();
      }
    });
    input.progress.conversationIndexMs = Math.round(performance.now() - conversationIndexStarted);
    input.progress.peakParticipatedConversationCount = participatedConversationIds.size;
    updateGraphProgress(input.progress, provider);
    const sentConversationMs = sentStarted ? Math.round(performance.now() - sentStarted) : 0;
    input.progress.phase = "messages";
    await saveProgress();

    const createAggregator = () => new StreamingReportAggregator({
      participatedConversationIds,
      includeDiagnostics: process.env.NODE_ENV !== "production"
    });
    let aggregator = createAggregator();
    const baseRecords: NormalizedMailboxRecord[] = [];
    const metadataStarted = performance.now();
    const metadataBaseline = { requestMs, coordinationMs, progressWriteMs };
    let aggregatorWallMs = 0;

    await provider.processMetadataWithAdaptiveFallback({
      baseOnly: true,
      scan: {
        ...microsoftScanDefaults,
        signal: input.signal
      },
      async onBatch(batch) {
        baseRecords.push(...batch.records);
        const aggregationStarted = performance.now();
        const timing = aggregator.processBatch(batch.records);
        aggregatorWallMs += performance.now() - aggregationStarted;
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
        await writeProgress(saveProgress);
      },
      async onFallback() {
        aggregator = createAggregator();
        baseRecords.length = 0;
        input.progress.processed = 0;
        input.progress.notes.push(
          "Outlook returned an oversized or invalid metadata page. Restarted the main scan with smaller pages."
        );
        updateGraphProgress(input.progress, provider!);
        await writeProgress(saveProgress, true);
      }
    });

    const metadataWallMs = performance.now() - metadataStarted;
    const scanMetrics = provider.getScanMetrics();
    const metadataFetchMs = requestMs - metadataBaseline.requestMs;
    const metadataCoordinationMs = coordinationMs - metadataBaseline.coordinationMs;
    const metadataProgressWriteMs = progressWriteMs - metadataBaseline.progressWriteMs;
    const mainMessageResponseBodyJsonMs = scanMetrics.mainMessageResponseBodyJsonMs ?? 0;
    const normalizationMs = scanMetrics.normalizationMs ?? 0;
    const metadataOtherMs = metadataWallMs - metadataFetchMs - metadataCoordinationMs -
      metadataProgressWriteMs - mainMessageResponseBodyJsonMs - normalizationMs - aggregatorWallMs;

    const progressive = createOutlookProgressiveState(baseRecords, participatedConversationIds, input.progress.startedAt);
    input.progress.outlookVerification = outlookVerification(progressive);
    input.progress.reportUsableMs = Math.round(performance.now() - started);
    input.progress.baseGraphPages = scanMetrics.graphPages;
    input.progress.baseGraphRequests = scanMetrics.requests;
    input.progress.status = input.progress.outlookVerification.status === "running" ? "running" : "completed";
    input.progress.completedAt = input.progress.status === "completed" ? Date.now() : undefined;
    input.progress.durationMs = Math.round(performance.now() - started);
    input.progress.messagesPerSecond = throughput(input.progress.processed, input.progress.durationMs);
    input.progress.messagesPerMinute = Math.round((input.progress.messagesPerSecond ?? 0) * 60);
    updateGraphProgress(input.progress, provider);

    const report = snapshotOutlookProgressive(progressive, participatedConversationIds, process.env.NODE_ENV !== "production");
    await setLiveScan(input.userId, {
      progress: input.progress,
      report,
      participatedConversationIds,
      outlookProgressive: progressive,
      expiresAt: nextExpiry()
    }, "microsoft", input.lockOwner);

    {
      console.info("Outlook scan metrics", {
        stage: "base",
        reportUsableMs: Math.round(performance.now() - started),
        enrichmentCandidates: input.progress.outlookVerification.candidates,
        responseBodyJsonMs: Math.round(scanMetrics.responseBodyJsonMs ?? 0),
        mainMessageResponseBodyJsonMs: Math.round(mainMessageResponseBodyJsonMs),
        normalizationMs: Math.round(normalizationMs),
        evidenceProcessingMs: Math.round(scanMetrics.evidenceProcessingMs ?? 0),
        headerProcessingMs: Math.round(scanMetrics.headerProcessingMs ?? 0),
        subjectProtectionMs: Math.round(subjectProtectionMs),
        aggregatorWallMs: Math.round(aggregatorWallMs),
        classificationMs: Math.round(protectionClassificationMs),
        aggregationMs: Math.round(aggregationMs),
        metadataWallMs: Math.round(metadataWallMs),
        metadataFetchMs: Math.round(metadataFetchMs),
        metadataCoordinationMs: Math.round(metadataCoordinationMs),
        metadataProgressWriteMs: Math.round(metadataProgressWriteMs),
        metadataOtherMs: Math.round(metadataOtherMs),
        folderRequests: provider.getScanMetrics().requestsByOperation?.folder_resolution ?? 0,
        conversationRequests: provider.getScanMetrics().requestsByOperation?.conversation_index ?? 0,
        credentialResolutionMs,
        folderResolutionMs,
        sentConversationMs,
        conversationIndexMs: input.progress.conversationIndexMs,
        metadataMs: input.progress.metadataMs,
        requestMs: Math.round(requestMs),
        coordinationMs: Math.round(coordinationMs),
        progressWriteMs: Math.round(progressWriteMs),
        progressWrites,
        retries: input.progress.graphRetries,
        tokenRefreshes: input.progress.graphTokenRefreshes,
        throttles: input.progress.graph429Throttles,
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

async function advanceMicrosoftEnrichment(input: { userId: string; providerConnectionId: string; session: LiveScanSession; lockOwner: string }) {
  const state = input.session.outlookProgressive!;
  const progress = input.session.progress;
  const participated = input.session.participatedConversationIds ?? new Set<string>();
  let unavailable = input.session.reportStale === true;
  let provider: MicrosoftProvider | undefined;
  let requestMs = 0;
  let coordinationMs = 0;
  try {
    if (!unavailable) {
      const active = await getActiveMicrosoftConnection(input.userId, input.providerConnectionId);
      if (!active) throw new Error("Connection unavailable.");
      const coordinate = createProviderRequestCoordinator(active.connection.id, {
        fenceAfterClaimOnly: process.env.NODE_ENV === "production",
        beforeRequest: createScanRequestFence(progress.scanId, input.lockOwner, "microsoft")
      });
      provider = new MicrosoftProvider(active.accessToken, {
        refreshAccessToken: () => forceRefreshMicrosoftConnection(input.userId, input.providerConnectionId),
        requestCoordinator: async request => {
          const started = performance.now();
          let transportMs = 0;
          try {
            return await coordinate(async () => {
              const transportStarted = performance.now();
              try { return await request(); }
              finally { transportMs += performance.now() - transportStarted; }
            });
          } finally {
            requestMs += transportMs;
            coordinationMs += performance.now() - started - transportMs;
          }
        }
      });
      // Cursor, normalized results and aggregates commit together under the scan lease.
      // A lost checkpoint replays only read-only work; committed exact IDs are skipped.
      const pending = new Map(state.queue.filter(index => state.records[index].verification === "pending")
        .map(index => [state.records[index].record.providerMessageId, index]));
      const sweep = input.session.outlookEnrichment ?? {
        pageSize: 500 as const, folders: await provider.getCleanupSafetyContext()
      };
      const page = await provider.getEnrichmentCollectionPage({ ...sweep, pendingIds: new Set(pending.keys()) });
      for (const [id, record] of page.records) {
        const index = pending.get(id);
        if (index !== undefined) applyOutlookCollectionRecord(state, index, record);
      }
      input.session.outlookEnrichment = { folders: sweep.folders, nextLink: page.nextLink, pageSize: page.pageSize };
      progress.enrichmentCollectionPages = (progress.enrichmentCollectionPages ?? 0) + 1;
      progress.enrichmentPageFallbacks = (progress.enrichmentPageFallbacks ?? 0) + Number(page.fallback);
      if (!page.nextLink) {
        for (const index of state.queue) {
          if (state.records[index].verification === "pending") applyOutlookEvidence(state, index, undefined);
        }
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    unavailable = true;
  }
  const metrics = provider?.getScanMetrics();
  progress.graphRequests = (progress.graphRequests ?? 0) + (metrics?.requests ?? 0);
  progress.graphHeaderEnrichmentRequests = (progress.graphHeaderEnrichmentRequests ?? 0) + (metrics?.requests ?? 0);
  progress.enrichmentRequests = (progress.enrichmentRequests ?? 0) + (metrics?.requests ?? 0);
  progress.enrichmentResponseBodyJsonMs = (progress.enrichmentResponseBodyJsonMs ?? 0) + (metrics?.responseBodyJsonMs ?? 0);
  progress.enrichmentRequestMs = (progress.enrichmentRequestMs ?? 0) + requestMs;
  progress.enrichmentCoordinationMs = (progress.enrichmentCoordinationMs ?? 0) + coordinationMs;
  progress.enrichmentRetries = (progress.enrichmentRetries ?? 0) + (metrics?.retries ?? 0);
  progress.enrichmentThrottles = (progress.enrichmentThrottles ?? 0) + (metrics?.throttles429 ?? 0);
  progress.enrichmentThrottleWaitMs = (progress.enrichmentThrottleWaitMs ?? 0) + (metrics?.throttleWaitMs ?? 0);
  progress.graphPages = (progress.graphPages ?? 0) + (metrics?.graphPages ?? 0);
  progress.graphRetries = (progress.graphRetries ?? 0) + (metrics?.retries ?? 0);
  progress.graphTokenRefreshes = (progress.graphTokenRefreshes ?? 0) + (metrics?.tokenRefreshes ?? 0);
  progress.graph429Throttles = (progress.graph429Throttles ?? 0) + (metrics?.throttles429 ?? 0);
  progress.graph429WaitMs = (progress.graph429WaitMs ?? 0) + (metrics?.throttleWaitMs ?? 0);
  progress.graph401Failures = (progress.graph401Failures ?? 0) + (metrics?.failures401 ?? 0);
  progress.graph403Failures = (progress.graph403Failures ?? 0) + (metrics?.failures403 ?? 0);
  progress.graph5xxFailures = (progress.graph5xxFailures ?? 0) + (metrics?.failures5xx ?? 0);
  progress.enrichmentDurationMs = Math.max(0, Date.now() - progress.startedAt - (progress.reportUsableMs ?? 0));
  progress.outlookVerification = outlookVerification(state, unavailable);
  progress.graphMessagesEnriched = progress.outlookVerification.checked - progress.outlookVerification.failed;
  progress.status = progress.outlookVerification.status === "running" ? "running" : "completed";
  if (progress.status === "completed") progress.completedAt = Date.now();
  progress.durationMs = Date.now() - progress.startedAt;
  const latest = await getLiveScanExecutionContext(progress.scanId);
  if (latest?.session.reportStale) {
    input.session.reportStale = true;
    progress.outlookVerification = outlookVerification(state, true);
    progress.status = "completed"; progress.completedAt = Date.now();
  }
  input.session.report = snapshotOutlookProgressive(state, participated, process.env.NODE_ENV !== "production");
  await setLiveScan(input.userId, { ...input.session, expiresAt: nextExpiry() }, "microsoft", input.lockOwner);
  console.info("Outlook suggestion verification metrics", {
    stage: "enrichment", enrichmentMode: "collection_full_headers",
    reportUsableMs: progress.reportUsableMs, baseMessages: progress.processed,
    baseGraphPages: progress.baseGraphPages, baseGraphRequests: progress.baseGraphRequests,
    enrichmentCandidates: progress.outlookVerification.candidates, messagesEnriched: progress.graphMessagesEnriched,
    checked: progress.outlookVerification.checked,
    failed: progress.outlookVerification.failed, status: progress.outlookVerification.status,
    leftInReview: progress.outlookVerification.candidates - progress.outlookVerification.checked + progress.outlookVerification.failed,
    enrichmentCollectionPages: progress.enrichmentCollectionPages, enrichmentRequests: progress.enrichmentRequests,
    responseBodyJsonMs: progress.enrichmentResponseBodyJsonMs, requestMs: progress.enrichmentRequestMs,
    coordinationMs: progress.enrichmentCoordinationMs, enrichmentPageFallbacks: progress.enrichmentPageFallbacks,
    enrichmentDurationMs: progress.enrichmentDurationMs, retries: progress.enrichmentRetries,
    throttles: progress.enrichmentThrottles, throttleWaitMs: progress.enrichmentThrottleWaitMs, totalDurationMs: progress.durationMs
  });
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
  const writeProgress = createDurableWriteGate(5_000);
  input.progress.outlookTransport = "imap";

  try {
    const activeConnection = await getActiveMicrosoftImapConnection(
      input.userId,
      input.providerConnectionId
    );
    provider = new OutlookImapProvider(activeConnection.accessToken, activeConnection.accountEmail, {
      beforeRequest: createScanRequestFence(input.progress.scanId, input.lockOwner, "microsoft")
    });
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
      await writeProgress(() => setLiveScan(input.userId, { progress: input.progress, expiresAt: nextExpiry() }, "microsoft", input.lockOwner));
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
      return;
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
