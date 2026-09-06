import type { InboxReport, OutlookScanDiagnostic } from "./types";

type OutlookScanProgressSnapshot = {
  scanId: string;
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  processed: number;
  graphPages?: number;
  graphRequests?: number;
  graphScanMode?: "full" | "delta";
  graphFoldersScanned?: number;
  graphMaxConcurrentRequests?: number;
  graphMetadataRequests?: number;
  graphHeaderEnrichmentRequests?: number;
  graphMessagesEnriched?: number;
  graphMainMessagePageSize?: number;
  graphMainMessagePageSizes?: number[];
  graphMainMessagePages?: number;
  graphMainMessagePageFallbacks?: number;
  graph429WaitMs?: number;
  graphPeakScanMemoryMb?: number;
  durationMs?: number;
  messagesPerSecond?: number;
  graphRetries?: number;
  graph401Failures?: number;
  graph403Failures?: number;
  graph429Throttles?: number;
  graph5xxFailures?: number;
  graphOther4xxFailures?: number;
  graphLastOther4xxStatus?: number;
  graphLastOther4xxCategory?: string;
  graphLastOther4xxOperation?: string;
  graphLastNonHttpFailureOperation?: string;
  graphLastNonHttpFailureCategory?: string;
  graphEvidenceAvailability?: OutlookScanDiagnostic["evidenceAvailability"];
  outlookTransport?: "graph" | "imap";
  imapFolders?: number;
  imapMetadataBatches?: number;
  imapCommands?: number;
  imapRetries?: number;
  imapErrors?: number;
  imapPeakScanMemoryMb?: number;
};

export function createOutlookScanDiagnostic(
  progress: OutlookScanProgressSnapshot
): OutlookScanDiagnostic {
  const evidence = progress.graphEvidenceAvailability;
  return {
    snapshotId: progress.scanId,
    transport: progress.outlookTransport ?? "graph",
    result: progress.status === "completed" ? "SUCCESS" : progress.status === "failed" ? "FAILED" : "PARTIAL",
    messagesScanned: progress.processed,
    graphPages: progress.graphPages ?? 0,
    graphRequests: progress.graphRequests ?? 0,
    scanMode: progress.graphScanMode ?? "full",
    foldersScanned: progress.graphFoldersScanned ?? 0,
    maxConcurrentGraphRequests: progress.graphMaxConcurrentRequests ?? 0,
    metadataRequests: progress.graphMetadataRequests ?? 0,
    headerEnrichmentRequests: progress.graphHeaderEnrichmentRequests ?? 0,
    messagesEnriched: progress.graphMessagesEnriched ?? 0,
    mainMessagePageSize: progress.graphMainMessagePageSize ?? 0,
    mainMessagePageSizes: [...(progress.graphMainMessagePageSizes ?? [])],
    mainMessagePages: progress.graphMainMessagePages ?? 0,
    mainMessagePageFallbacks: progress.graphMainMessagePageFallbacks ?? 0,
    throttleWaitMs: progress.graph429WaitMs ?? 0,
    peakScanMemoryMb: progress.graphPeakScanMemoryMb ?? 0,
    imapFolders: progress.imapFolders ?? 0,
    imapMetadataBatches: progress.imapMetadataBatches ?? 0,
    imapCommands: progress.imapCommands ?? 0,
    imapRetries: progress.imapRetries ?? 0,
    imapErrors: progress.imapErrors ?? 0,
    imapPeakScanMemoryMb: progress.imapPeakScanMemoryMb ?? 0,
    durationMs: progress.durationMs ?? 0,
    messagesPerSecond: progress.messagesPerSecond ?? 0,
    evidenceAvailability: {
      conversationIdentity: evidence?.conversationIdentity === true,
      importance: evidence?.importance === true,
      categories: evidence?.categories === true,
      listId: evidence?.listId === true,
      listUnsubscribe: evidence?.listUnsubscribe === true,
      autoSubmitted: evidence?.autoSubmitted === true,
      precedence: evidence?.precedence === true
    },
    providerFailures: {
      unauthorized401: progress.graph401Failures ?? 0,
      forbidden403: progress.graph403Failures ?? 0,
      throttled429: progress.graph429Throttles ?? 0,
      server5xx: progress.graph5xxFailures ?? 0,
      other4xx: progress.graphOther4xxFailures ?? 0,
      lastOther4xxStatus: progress.graphLastOther4xxStatus,
      lastOther4xxCategory: progress.graphLastOther4xxCategory,
      lastOther4xxOperation: progress.graphLastOther4xxOperation,
      lastNonHttpFailureOperation: progress.graphLastNonHttpFailureOperation,
      lastNonHttpFailureCategory: progress.graphLastNonHttpFailureCategory,
      retries: progress.graphRetries ?? 0
    }
  };
}

export function formatOutlookScanSummary(
  report: InboxReport,
  diagnostic: OutlookScanDiagnostic
): string {
  if (!report.classifierDiagnostics) {
    throw new Error("Outlook classifier diagnostics are not available for this report.");
  }
  const signals = report.classifierDiagnostics.messageSignals;
  const availability = diagnostic.evidenceAvailability;
  const failures = diagnostic.providerFailures;
  const safetyInvariantViolations =
    report.classifierDiagnostics.readyStrongSignals.withHardProtectionMessages +
    report.classifierDiagnostics.readyStrongSignals.withoutStrongSignalMessages;

  return [
    "ORGANIZINBOX DEV OUTLOOK SCAN SUMMARY",
    "",
    "Mailbox",
    "Provider: Microsoft",
    `Transport: ${diagnostic.transport}`,
    line("Messages scanned", diagnostic.messagesScanned),
    line("Graph pages", diagnostic.graphPages),
    line("Graph requests", diagnostic.graphRequests),
    `Scan mode: ${diagnostic.scanMode}`,
    line("Folders scanned", diagnostic.foldersScanned),
    line("Max concurrent Graph requests", diagnostic.maxConcurrentGraphRequests),
    line("Metadata requests", diagnostic.metadataRequests),
    line("Header-enrichment requests", diagnostic.headerEnrichmentRequests),
    line("Messages enriched", diagnostic.messagesEnriched),
    line("Main message page size", diagnostic.mainMessagePageSize),
    `Main message page sizes: ${diagnostic.mainMessagePageSizes.length > 0 ? diagnostic.mainMessagePageSizes.join(", ") : "unavailable"}`,
    line("Main message pages", diagnostic.mainMessagePages),
    line("Main message page fallbacks", diagnostic.mainMessagePageFallbacks),
    `429 waits: ${integer(diagnostic.throttleWaitMs)} ms`,
    `Peak per-scan memory estimate: ${decimal(diagnostic.peakScanMemoryMb)} MB`,
    line("IMAP folders", diagnostic.imapFolders),
    line("IMAP metadata batches", diagnostic.imapMetadataBatches),
    line("IMAP commands/round trips", diagnostic.imapCommands),
    line("IMAP retries", diagnostic.imapRetries),
    line("IMAP errors", diagnostic.imapErrors),
    `IMAP peak memory estimate: ${decimal(diagnostic.imapPeakScanMemoryMb)} MB`,
    `Scan duration: ${integer(diagnostic.durationMs)} ms`,
    `Messages/sec: ${decimal(diagnostic.messagesPerSecond)}`,
    "",
    "Classification",
    line("Suggested", report.totals.cleanupCandidates),
    line("Review", report.totals.reviewMessages),
    line("Protected", report.totals.protectedMessages),
    line("Sender groups", report.senders.length),
    line("Safety invariant violations", safetyInvariantViolations),
    "",
    "Protection",
    line("Recent", signals.recentMessages),
    line("Important", signals.importantMessages),
    line("Sent excluded", signals.sentMessages),
    line("Draft excluded", signals.draftMessages),
    line("Deleted Items excluded", signals.deletedItemsMessages),
    line("Transactional Subject protection", signals.transactionalSubjectMessages),
    line("Security/account Subject protection", signals.securityAccountSubjectMessages),
    "",
    "Evidence availability",
    available("Conversation identity", availability.conversationIdentity),
    available("Importance", availability.importance),
    available("Categories", availability.categories),
    available("List-Id", availability.listId),
    available("List-Unsubscribe", availability.listUnsubscribe),
    available("Auto-Submitted", availability.autoSubmitted),
    available("Precedence", availability.precedence),
    "",
    "Provider",
    line("401 failures", failures.unauthorized401),
    line("403 failures", failures.forbidden403),
    line("429 throttles", failures.throttled429),
    line("5xx failures", failures.server5xx),
    line("Other 4xx failures", failures.other4xx),
    optional("Last other 4xx status", failures.lastOther4xxStatus),
    `Last other 4xx category: ${failures.lastOther4xxCategory ?? "unavailable"}`,
    `Last other 4xx operation: ${failures.lastOther4xxOperation ?? "unavailable"}`,
    `Last non-HTTP failure operation: ${failures.lastNonHttpFailureOperation ?? "unavailable"}`,
    `Last non-HTTP failure category: ${failures.lastNonHttpFailureCategory ?? "unavailable"}`,
    line("Retries", failures.retries),
    "",
    "Privacy",
    "Body fetched: no",
    "BodyPreview fetched: no",
    "Attachments fetched: no",
    "Raw Subject persisted: no",
    "Microsoft message IDs persisted: no",
    "Headers persisted: no",
    "Tokens exposed: no",
    "",
    "Result",
    diagnostic.result
  ].join("\n");
}

function line(label: string, value: number) {
  return `${label}: ${integer(value)}`;
}

function optional(label: string, value: number | undefined) {
  return value === undefined ? `${label}: unavailable` : line(label, value);
}

function integer(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function decimal(value: number) {
  return Math.max(0, value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function available(label: string, value: boolean) {
  return `${label}: ${value ? "available" : "unavailable"}`;
}
