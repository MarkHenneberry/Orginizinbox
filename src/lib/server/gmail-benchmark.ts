import "server-only";
import { randomUUID } from "node:crypto";
import { GmailProvider } from "@/lib/providers/gmail/provider";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import { buildCleanupSenderGroups } from "@/lib/providers/gmail/cleanup-candidates";
import {
  toGmailScalableEligibleIdentity,
  type GmailScalableEligibleIdentity,
  type GmailScalableScanIdentity
} from "@/lib/providers/gmail/scalable-targets";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import {
  acceptLiveScan,
  createProgress,
  getLiveScanExecutionContext,
  nextExpiry,
  setLiveScan,
  type BenchmarkLimit,
  type BenchmarkProgress
} from "@/lib/server/live-scan-store";
import { startProviderScanWorkflow } from "@/lib/server/provider-scan-workflow-start";

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

export async function createGmailBenchmarkSession(input: {
  userId: string;
  providerConnectionId: string;
  limit: BenchmarkLimit;
  batchSize: number;
}) {
  const progress = createProgress({
    scanId: randomUUID(),
    limit: input.limit,
    batchSize: input.batchSize
  });

  const accepted = await acceptLiveScan({
    userId: input.userId,
    providerConnectionId: input.providerConnectionId,
    session: {
    progress,
    expiresAt: nextExpiry()
    }
  });
  await startProviderScanWorkflow(accepted.session.progress.scanId);
  return { progress: accepted.session.progress, reused: accepted.reused };
}

export function createGmailScanSession(input: {
  userId: string;
  providerConnectionId: string;
}) {
  return createGmailBenchmarkSession({
    userId: input.userId,
    providerConnectionId: input.providerConnectionId,
    ...normalGmailScanDefaults
  });
}

export async function runGmailBenchmark(input: { scanId: string; lockOwner: string }) {
  const context = await getLiveScanExecutionContext(input.scanId);
  if (!context || context.lockOwner !== input.lockOwner || context.session.progress.provider !== "gmail") return;
  const progress = createProgress({
    scanId: input.scanId,
    limit: context.session.progress.limit,
    batchSize: context.session.progress.batchSize,
    provider: "gmail"
  });
  progress.duplicateStartCount = context.session.progress.duplicateStartCount;
  await setLiveScan(context.userId, { progress, expiresAt: nextExpiry() }, "gmail", input.lockOwner);
  return executeGmailBenchmark({
    userId: context.userId,
    providerConnectionId: context.providerConnectionId,
    limit: progress.limit,
    batchSize: progress.batchSize,
    progress,
    signal: new AbortController().signal,
    lockOwner: input.lockOwner
  });
}

async function executeGmailBenchmark(input: {
  userId: string;
  providerConnectionId: string;
  limit: BenchmarkLimit;
  batchSize: number;
  progress: BenchmarkProgress;
  signal: AbortSignal;
  lockOwner: string;
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
    const identitiesByProviderMessageId = new Map<string, GmailScalableScanIdentity>();
    const eligibleIdentities: GmailScalableEligibleIdentity[] = [];
    const aggregator = new StreamingReportAggregator({
      participatedConversationIds,
      includeDiagnostics: process.env.NODE_ENV !== "production",
      onClassified(classified) {
        const identity = identitiesByProviderMessageId.get(classified.providerMessageId);
        if (!identity) return;
        const eligible = toGmailScalableEligibleIdentity(identity, classified);
        if (eligible) eligibleIdentities.push(eligible);
      }
    });
    let connectedAt: number | undefined;
    let gmailUidValidity: string | undefined;
    let scalableIdentityBridgeAvailable = false;
    const numericLimit = input.limit === "full" ? "full" : input.limit;
    const scanConnectionStarted = performance.now();

    for await (const batch of provider.scanMetadata({
      batchSize: input.batchSize,
      limit: numericLimit,
      signal: input.signal,
      onConnected: ({ mailboxPath, mailboxExists, uidValidity, scalableIdentityBridgeAvailable: bridgeAvailable }) => {
        connectedAt = performance.now();
        input.progress.connectionMs = Math.round(connectedAt - scanConnectionStarted);
        input.progress.mailboxPath = mailboxPath;
        input.progress.mailboxExists = mailboxExists;
        gmailUidValidity = uidValidity;
        scalableIdentityBridgeAvailable = bridgeAvailable === true;
      }
    })) {
      for (const identity of batch.gmailScalableIdentities ?? []) {
        identitiesByProviderMessageId.set(identity.providerMessageId, identity);
      }
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
      await setLiveScan(input.userId, { progress: input.progress, expiresAt: nextExpiry() }, "gmail", input.lockOwner);
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

    const report = aggregator.snapshot("gmail", false);
    await setLiveScan(input.userId, {
      progress: input.progress,
      report,
      participatedConversationIds,
      gmailUidValidity,
      scalableCleanupTargets:
        scalableIdentityBridgeAvailable && gmailUidValidity
          ? buildScalableCleanupTargets(report.senders, eligibleIdentities)
          : undefined,
      expiresAt: nextExpiry()
    }, "gmail", input.lockOwner);
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
    await setLiveScan(input.userId, { progress: input.progress, expiresAt: nextExpiry() }, "gmail", input.lockOwner);
  }
}

function buildScalableCleanupTargets(
  senders: ReturnType<StreamingReportAggregator["snapshot"]>["senders"],
  identities: readonly GmailScalableEligibleIdentity[]
) {
  const groups = buildCleanupSenderGroups(senders);
  const groupIndexBySender = new Map(
    senders.map((sender, index) => [sender.senderKey.toLocaleLowerCase("en-US"), groups[index].eligible ? index : undefined])
  );
  return [...identities]
    .sort((left, right) => left.scanOrdinal - right.scanOrdinal)
    .flatMap((identity) => {
      const groupIndex = groupIndexBySender.get(identity.senderKey);
      return groupIndex === undefined
        ? []
        : [{
            uid: identity.uid,
            apiMessageId: identity.apiMessageId,
            groupIndex,
            immutableEvidence: identity.immutableEvidence
          }];
    });
}

function throughput(processed: number, durationMs?: number) {
  if (!durationMs || durationMs <= 0) return 0;
  return Math.round((processed / (durationMs / 1000)) * 100) / 100;
}

function safeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Gmail benchmark failed.";
}
