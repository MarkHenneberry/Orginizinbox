import { deriveSubjectProtection } from "@/lib/domain/subject-protection";
import type { NormalizedMailboxRecord } from "@/lib/domain/types";
import { microsoftRequestedScopes } from "@/lib/providers/microsoft/scopes";
import {
  MicrosoftGraphClient,
  MicrosoftGraphClientResponseError,
  MicrosoftGraphMalformedResponseError,
  MicrosoftGraphMutationUncertainError,
  MicrosoftGraphUnavailableError,
  type MicrosoftGraphBatchRequest,
  type MicrosoftGraphOperation
} from "./graph-client";
import type {
  MailboxProcessor,
  MailboxProfile,
  MoveApprovedMessagesToTrashInput,
  MoveApprovedMessagesToTrashResult,
  ScanMetadataBatch,
  ScanMetadataInput,
  SearchCleanupGroupBatch,
  SearchCleanupGroupInput
} from "../types";

export const microsoftScopes = {
  connection: [...microsoftRequestedScopes]
};

export const microsoftMessageSelect = [
  "id",
  "conversationId",
  "from",
  "receivedDateTime",
  "isRead",
  "importance",
  "flag",
  "categories",
  "subject",
  "parentFolderId",
  "isDraft",
  "internetMessageHeaders"
] as const;

export const microsoftMainMessagePreferredPageSize = 100;
export const microsoftMainMessageFallbackPageSize = 50;
export const microsoftExperimentalFolderPageSize = 200;
export const microsoftFolderScanConcurrency = 2;

export const microsoftClassifierHeaderAllowlist = [
  "list-id",
  "list-unsubscribe",
  "auto-submitted",
  "precedence"
] as const;

type MicrosoftProviderOptions = {
  refreshAccessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxRetries?: number;
  requestCoordinator?: <T>(request: () => Promise<T>) => Promise<T>;
  random?: () => number;
  experimentalFolderScan?: boolean;
};

type GraphCollectionPage<T> = {
  value: T[];
  "@odata.nextLink"?: string;
};

type GraphFolder = {
  id?: unknown;
  childFolderCount?: unknown;
  totalItemCount?: unknown;
};

type GraphMessage = {
  id?: unknown;
  conversationId?: unknown;
  from?: unknown;
  receivedDateTime?: unknown;
  isRead?: unknown;
  importance?: unknown;
  flag?: unknown;
  categories?: unknown;
  subject?: unknown;
  parentFolderId?: unknown;
  isDraft?: unknown;
  internetMessageHeaders?: unknown;
};

export type MicrosoftFolderKind = "sent" | "draft" | "deleted";

export type MicrosoftFolderIndex = {
  knownFolderIds: Set<string>;
  kindByFolderId: Map<string, MicrosoftFolderKind>;
  sentFolderIds: Set<string>;
  deletedItemsFolderId?: string;
  inboxTotal?: number;
  totalItemCountByFolderId?: Map<string, number | undefined>;
};

export type MicrosoftCleanupSafetyContext = {
  knownFolderIds: string[];
  kindByFolderId: Array<[string, MicrosoftFolderKind]>;
  sentFolderIds: string[];
  deletedItemsFolderId: string;
};

export type MicrosoftCleanupMessage = {
  record: NormalizedMailboxRecord;
  parentFolderId: string;
};

export type MicrosoftCleanupMoveInput = {
  messageId: string;
  destinationFolderId: string;
};

export type MicrosoftCleanupMoveResult =
  | { outcome: "success"; messageId: string }
  | { outcome: "rejected" }
  | { outcome: "uncertain" };

const emptyEvidenceAvailability = () => ({
  conversationIdentity: false,
  importance: false,
  categories: false,
  listId: false,
  listUnsubscribe: false,
  autoSubmitted: false,
  precedence: false
});

export class MicrosoftProvider implements MailboxProcessor {
  private readonly graph: MicrosoftGraphClient;
  private readonly experimentalFolderScan: boolean;
  private folderIndexPromise?: Promise<MicrosoftFolderIndex>;
  private graphPages = 0;
  private mainMessagePageSize = microsoftMainMessagePreferredPageSize;
  private mainMessagePages = 0;
  private mainMessagePageFallbacks = 0;
  private readonly mainMessagePageSizes = new Set<number>();
  private readonly scannedFolderIds = new Set<string>();
  private peakRetainedBytes = 0;
  private readonly evidenceAvailability = emptyEvidenceAvailability();

  constructor(accessToken: string, options: MicrosoftProviderOptions = {}) {
    const { experimentalFolderScan = false, ...graphOptions } = options;
    this.experimentalFolderScan = process.env.NODE_ENV !== "production" && experimentalFolderScan;
    this.mainMessagePageSize = this.experimentalFolderScan
      ? microsoftExperimentalFolderPageSize
      : microsoftMainMessagePreferredPageSize;
    this.graph = new MicrosoftGraphClient({ accessToken, ...graphOptions });
  }

  getScanMetrics() {
    return {
      graphPages: this.graphPages,
      mainMessagePageSize: this.mainMessagePageSize,
      mainMessagePages: this.mainMessagePages,
      mainMessagePageFallbacks: this.mainMessagePageFallbacks,
      mainMessagePageSizes: [...this.mainMessagePageSizes].sort((a, b) => b - a),
      foldersScanned: this.scannedFolderIds.size,
      metadataRequests: this.graph.getMetrics().requestsByOperation.main_message_scan ?? 0,
      headerEnrichmentRequests: 0,
      messagesEnriched: 0,
      peakRetainedMemoryMb: Math.round((this.peakRetainedBytes / 1024 / 1024) * 100) / 100,
      evidenceAvailability: { ...this.evidenceAvailability },
      ...this.graph.getMetrics()
    };
  }

  async getMailboxProfile(): Promise<MailboxProfile> {
    const folders = await this.getFolderIndex();
    return {
      provider: "microsoft",
      externalAccountId: "microsoft-connected-mailbox",
      messageCount: folders.inboxTotal
    };
  }

  async scanParticipatedConversationIds(input: Pick<ScanMetadataInput, "batchSize" | "signal">) {
    const folders = await this.getFolderIndex(input.signal);
    const participatedConversationIds = new Set<string>();
    const pageSize = boundedPageSize(input.batchSize);

    for (const folderId of folders.sentFolderIds) {
      const firstPath = collectionPath(`/me/mailFolders/${encodeURIComponent(folderId)}/messages`, {
        "$select": "conversationId",
        "$top": String(pageSize)
      });
      for await (const page of this.pages<GraphMessage>(
        firstPath,
        input.signal,
        "conversation_index"
      )) {
        for (const message of page.value) {
          if (typeof message.conversationId === "string" && message.conversationId) {
            this.evidenceAvailability.conversationIdentity = true;
            participatedConversationIds.add(message.conversationId);
          }
        }
      }
    }

    return participatedConversationIds;
  }

  async *scanMetadata(input: ScanMetadataInput): AsyncIterable<ScanMetadataBatch> {
    if (this.experimentalFolderScan) {
      yield* this.scanMetadataByFolderExperiment(input);
      return;
    }
    yield* this.scanMailboxMetadata(input);
  }

  private async *scanMailboxMetadata(input: ScanMetadataInput): AsyncIterable<ScanMetadataBatch> {
    const folders = await this.getFolderIndex(input.signal);
    const pageSize = this.mainMessagePageSize;
    const numericLimit = input.limit === undefined || input.limit === "full" ? undefined : input.limit;
    const outputBatchSize = boundedPageSize(input.batchSize);
    let processed = 0;

    input.onConnected?.({
      mailboxPath: "Microsoft mailbox",
      mailboxExists: 0,
      readOnly: true
    });
    this.scannedFolderIds.add("mailbox-wide");
    const firstPath = collectionPath("/me/messages", {
      "$select": microsoftMessageSelect.join(","),
      "$top": String(pageSize)
    });

    for await (const page of this.pages<GraphMessage>(firstPath, input.signal, "main_message_scan")) {
      this.mainMessagePageSizes.add(pageSize);
      const remaining = numericLimit === undefined ? page.value.length : Math.max(0, numericLimit - processed);
      const messages = remaining >= page.value.length ? page.value : page.value.slice(0, remaining);
      this.observeRetainedMessages(messages);
      for (const batchMessages of chunks(messages, outputBatchSize)) {
        let subjectProtectionMs = 0;
        let records: NormalizedMailboxRecord[];
        try {
          batchMessages.forEach((message) => this.observeEvidenceAvailability(message));
          const subjectStarted = performance.now();
          const subjectProtection = batchMessages.map((message) =>
            deriveSubjectProtection(typeof message.subject === "string" ? message.subject : undefined)
          );
          subjectProtectionMs = performance.now() - subjectStarted;
          records = batchMessages.map((message, index) =>
            normalizeMicrosoftMessage(message, folders, subjectProtection[index])
          );
          for (const message of batchMessages) message.internetMessageHeaders = undefined;
          subjectProtection.length = 0;
        } catch (error) {
          this.graph.recordNonHttpFailure("main_message_scan", "normalization");
          throw error;
        }
        processed += records.length;
        yield { records, subjectProtectionMs };
      }
      page.value.length = 0;
      if (numericLimit !== undefined && processed >= numericLimit) return;
    }
  }

  private async *scanMetadataByFolderExperiment(input: ScanMetadataInput): AsyncIterable<ScanMetadataBatch> {
    const folders = await this.getFolderIndex(input.signal);
    const pageSize = this.mainMessagePageSize;
    const numericLimit = input.limit === undefined || input.limit === "full" ? undefined : input.limit;
    const outputBatchSize = boundedPageSize(input.batchSize);
    const seenMessageIds = new Set<string>();
    const folderIds = [...folders.knownFolderIds]
      .filter((folderId) => folders.totalItemCountByFolderId?.get(folderId) !== 0)
      .sort();
    const output = new AsyncResultQueue<ScanMetadataBatch>(4);
    let nextFolderIndex = 0;
    let reserved = 0;
    let attemptFailed = false;

    input.onConnected?.({
      mailboxPath: "Microsoft mailbox",
      mailboxExists: 0,
      readOnly: true
    });

    const scanFolder = async () => {
      while (true) {
        if (attemptFailed) return;
        const folderId = folderIds[nextFolderIndex];
        nextFolderIndex += 1;
        if (!folderId || (numericLimit !== undefined && reserved >= numericLimit)) return;
        this.scannedFolderIds.add(folderId);
        const firstPath = collectionPath(`/me/mailFolders/${encodeURIComponent(folderId)}/messages`, {
          "$select": microsoftMessageSelect.join(","),
          "$top": String(pageSize)
        });
        for await (const page of this.pages<GraphMessage>(firstPath, input.signal, "main_message_scan")) {
          if (attemptFailed) return;
          this.mainMessagePageSizes.add(pageSize);
          const uniqueMessages: GraphMessage[] = [];
          for (const message of page.value) {
            if (numericLimit !== undefined && reserved >= numericLimit) break;
            if (typeof message.id === "string" && seenMessageIds.has(message.id)) continue;
            if (typeof message.id === "string") seenMessageIds.add(message.id);
            uniqueMessages.push(message);
            reserved += 1;
          }
          this.observeRetainedMessages(uniqueMessages);
          for (const messages of chunks(uniqueMessages, outputBatchSize)) {
            let subjectProtectionMs = 0;
            let records: NormalizedMailboxRecord[];
            try {
              messages.forEach((message) => this.observeEvidenceAvailability(message));
              const subjectStarted = performance.now();
              const subjectProtection = messages.map((message) =>
                deriveSubjectProtection(typeof message.subject === "string" ? message.subject : undefined)
              );
              subjectProtectionMs = performance.now() - subjectStarted;
              records = messages.map((message, index) =>
                normalizeMicrosoftMessage(message, folders, subjectProtection[index])
              );
              for (const message of messages) message.internetMessageHeaders = undefined;
              subjectProtection.length = 0;
            } catch (error) {
              this.graph.recordNonHttpFailure("main_message_scan", "normalization");
              throw error;
            }
            await output.push({ records, subjectProtectionMs });
          }
          page.value.length = 0;
          if (numericLimit !== undefined && reserved >= numericLimit) return;
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(microsoftFolderScanConcurrency, Math.max(1, folderIds.length)) },
      async () => {
        try {
          await scanFolder();
        } catch (error) {
          attemptFailed = true;
          throw error;
        }
      }
    );
    void Promise.allSettled(workers).then((results) => {
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) output.fail(failed.reason);
      else output.close();
    });
    for await (const batch of output) yield batch;
  }

  async processMetadataWithAdaptiveFallback(input: {
    scan: ScanMetadataInput;
    onBatch: (batch: ScanMetadataBatch) => void | Promise<void>;
    onFallback: () => void | Promise<void>;
  }) {
    while (true) {
      try {
        for await (const batch of this.scanMetadata(input.scan)) {
          await input.onBatch(batch);
        }
        return;
      } catch (error) {
        if (!this.prepareConservativeMainMessageRetry(error)) throw error;
        await input.onFallback();
      }
    }
  }

  async *searchCleanupGroup(_input: SearchCleanupGroupInput): AsyncIterable<SearchCleanupGroupBatch> {
    void _input;
    throw new Error("Outlook cleanup is not available.");
  }

  async moveApprovedMessagesToTrash(_input: MoveApprovedMessagesToTrashInput): Promise<MoveApprovedMessagesToTrashResult> {
    void _input;
    throw new Error("Outlook cleanup is not available.");
  }

  async getDeletedItemsFolderId(signal?: AbortSignal) {
    const folders = await this.getFolderIndex(signal);
    if (!folders.deletedItemsFolderId) throw new MicrosoftGraphMalformedResponseError();
    return folders.deletedItemsFolderId;
  }

  async getCleanupSafetyContext(signal?: AbortSignal): Promise<MicrosoftCleanupSafetyContext> {
    const folders = await this.getFolderIndex(signal);
    if (!folders.deletedItemsFolderId) throw new MicrosoftGraphMalformedResponseError();
    return {
      knownFolderIds: [...folders.knownFolderIds],
      kindByFolderId: [...folders.kindByFolderId],
      sentFolderIds: [...folders.sentFolderIds],
      deletedItemsFolderId: folders.deletedItemsFolderId
    };
  }

  async getCleanupMessage(
    messageId: string,
    operation: "cleanup_safety_recheck" = "cleanup_safety_recheck",
    signal?: AbortSignal
  ): Promise<MicrosoftCleanupMessage> {
    const folders = await this.getFolderIndex(signal);
    const path = collectionPath(`/me/messages/${encodeURIComponent(messageId)}`, {
      "$select": microsoftMessageSelect.join(",")
    });
    const message = await this.graph.getJson<GraphMessage>(path, signal, operation);
    if (typeof message.parentFolderId !== "string" || !message.parentFolderId) {
      throw new MicrosoftGraphMalformedResponseError();
    }
    return {
      record: normalizeMicrosoftMessage(message, folders),
      parentFolderId: message.parentFolderId
    };
  }

  async getCleanupMessages(
    messageIds: readonly string[],
    safetyContext?: MicrosoftCleanupSafetyContext
  ): Promise<Array<MicrosoftCleanupMessage | undefined>> {
    const folders = safetyContext ? folderIndexFromCleanupContext(safetyContext) : await this.getFolderIndex();
    const requests = messageIds.map((messageId, index): MicrosoftGraphBatchRequest => ({
      id: String(index),
      method: "GET",
      url: collectionPath(`/me/messages/${encodeURIComponent(messageId)}`, {
        "$select": microsoftMessageSelect.join(",")
      })
    }));
    const responses = await this.graph.batchJson(requests, "cleanup_safety_recheck", { mutation: false });
    return responses.map((response) => {
      if (response.status === 404) return undefined;
      if (response.status !== 200) throw new MicrosoftGraphUnavailableError(response.status);
      try {
        const message = response.body as GraphMessage;
        if (typeof message.parentFolderId !== "string" || !message.parentFolderId) return undefined;
        return {
          record: normalizeMicrosoftMessage(message, folders),
          parentFolderId: message.parentFolderId
        };
      } catch {
        return undefined;
      }
    });
  }

  async moveCleanupMessage(
    messageId: string,
    destinationFolderId: string,
    operation: "cleanup_move" | "cleanup_restore"
  ) {
    const response = await this.graph.postJson<GraphMessage>(
      `/me/messages/${encodeURIComponent(messageId)}/move`,
      { destinationId: destinationFolderId },
      operation
    );
    if (response.status !== 201 || typeof response.value.id !== "string" || !response.value.id) {
      this.graph.recordNonHttpFailure(operation, "invalid_shape");
      throw new MicrosoftGraphMutationUncertainError();
    }
    return response.value.id;
  }

  async moveCleanupMessages(
    inputs: readonly MicrosoftCleanupMoveInput[],
    operation: "cleanup_move" | "cleanup_restore"
  ): Promise<MicrosoftCleanupMoveResult[]> {
    const requests = inputs.map((input, index): MicrosoftGraphBatchRequest => ({
      id: String(index),
      method: "POST",
      url: `/me/messages/${encodeURIComponent(input.messageId)}/move`,
      headers: { "Content-Type": "application/json" },
      body: { destinationId: input.destinationFolderId }
    }));
    const responses = await this.graph.batchJson(requests, operation, { mutation: true });
    return responses.map((response): MicrosoftCleanupMoveResult => {
      if (response.status === 201) {
        const message = response.body as GraphMessage;
        if (typeof message?.id === "string" && message.id) {
          return { outcome: "success", messageId: message.id };
        }
        return { outcome: "uncertain" };
      }
      if (response.status >= 400 && response.status < 500) return { outcome: "rejected" };
      return { outcome: "uncertain" };
    });
  }

  async verifyCleanupMessageLocation(
    messageId: string,
    expectedFolderId: string,
    operation: "cleanup_move_verify" | "cleanup_restore_verify",
    signal?: AbortSignal
  ) {
    const path = collectionPath(`/me/messages/${encodeURIComponent(messageId)}`, {
      "$select": "id,parentFolderId"
    });
    const message = await this.graph.getJson<GraphMessage>(path, signal, operation);
    if (typeof message.id !== "string" || !message.id || typeof message.parentFolderId !== "string") {
      this.graph.recordNonHttpFailure(operation, "invalid_shape");
      throw new MicrosoftGraphMalformedResponseError();
    }
    return message.id === messageId && message.parentFolderId === expectedFolderId;
  }

  async verifyCleanupMessageLocations(
    inputs: readonly MicrosoftCleanupMoveInput[],
    operation: "cleanup_move_verify" | "cleanup_restore_verify"
  ): Promise<boolean[]> {
    const requests = inputs.map((input, index): MicrosoftGraphBatchRequest => ({
      id: String(index),
      method: "GET",
      url: collectionPath(`/me/messages/${encodeURIComponent(input.messageId)}`, {
        "$select": "id,parentFolderId"
      })
    }));
    const responses = await this.graph.batchJson(requests, operation, { mutation: false });
    return responses.map((response, index) => {
      if (response.status !== 200) return false;
      const message = response.body as GraphMessage;
      return typeof message?.id === "string" &&
        message.id === inputs[index].messageId &&
        message.parentFolderId === inputs[index].destinationFolderId;
    });
  }

  async disconnect(): Promise<void> {
    throw new Error("Microsoft provider revocation is not part of local disconnect.");
  }

  private getFolderIndex(signal?: AbortSignal) {
    this.folderIndexPromise ??= this.loadFolderIndex(signal);
    return this.folderIndexPromise;
  }

  private observeEvidenceAvailability(message: GraphMessage) {
    if (typeof message.conversationId === "string") this.evidenceAvailability.conversationIdentity = true;
    if (typeof message.importance === "string") this.evidenceAvailability.importance = true;
    if (Array.isArray(message.categories)) this.evidenceAvailability.categories = true;
    if (Array.isArray(message.internetMessageHeaders)) {
      this.evidenceAvailability.listId = true;
      this.evidenceAvailability.listUnsubscribe = true;
      this.evidenceAvailability.autoSubmitted = true;
      this.evidenceAvailability.precedence = true;
    }
  }

  private observeRetainedMessages(messages: readonly GraphMessage[]) {
    this.peakRetainedBytes = Math.max(
      this.peakRetainedBytes,
      messages.reduce((total, message) => total + estimateGraphMessageBytes(message), 0) *
        (this.experimentalFolderScan ? microsoftFolderScanConcurrency : 1)
    );
  }

  private prepareConservativeMainMessageRetry(error: unknown) {
    if (this.mainMessagePageSize <= microsoftMainMessageFallbackPageSize) return false;
    const metrics = this.graph.getMetrics();
    const invalidMainPage =
      error instanceof MicrosoftGraphMalformedResponseError &&
      metrics.lastNonHttpFailureOperation === "main_message_scan" &&
      (metrics.lastNonHttpFailureCategory === "invalid_json" ||
        metrics.lastNonHttpFailureCategory === "invalid_shape");
    const oversizedMainPage =
      error instanceof MicrosoftGraphClientResponseError &&
      error.status === 413 &&
      metrics.lastOther4xxOperation === "main_message_scan";
    if (!invalidMainPage && !oversizedMainPage) return false;
    this.mainMessagePageSize = this.mainMessagePageSize > microsoftMainMessagePreferredPageSize
      ? microsoftMainMessagePreferredPageSize
      : microsoftMainMessageFallbackPageSize;
    this.mainMessagePages = 0;
    this.mainMessagePageFallbacks += 1;
    this.mainMessagePageSizes.clear();
    this.scannedFolderIds.clear();
    this.peakRetainedBytes = 0;
    return true;
  }

  private async loadFolderIndex(signal?: AbortSignal): Promise<MicrosoftFolderIndex> {
    const knownFolderIds = new Set<string>();
    const kindByFolderId = new Map<string, MicrosoftFolderKind>();
    const sentFolderIds = new Set<string>();
    const totalItemCountByFolderId = new Map<string, number | undefined>();
    const foldersToVisit: Array<{ id: string; inheritedKind?: MicrosoftFolderKind }> = [];
    const queuedFolderIds = new Set<string>();
    let inboxTotal: number | undefined;
    let deletedItemsFolderId: string | undefined;
    const enqueue = (folder: ReturnType<typeof normalizeFolder>, inheritedKind?: MicrosoftFolderKind) => {
      if (folder.childFolderCount <= 0 || queuedFolderIds.has(folder.id)) return;
      queuedFolderIds.add(folder.id);
      foldersToVisit.push({ id: folder.id, inheritedKind });
    };

    for (const wellKnown of wellKnownFolders) {
      const path = collectionPath(`/me/mailFolders/${wellKnown.name}`, {
        "$select": "id,childFolderCount,totalItemCount"
      });
      const folderValue = await this.graph.getJson<GraphFolder>(
        path,
        signal,
        "folder_resolution"
      );
      const folder = this.normalizeFolderResponse(folderValue);
      knownFolderIds.add(folder.id);
      totalItemCountByFolderId.set(folder.id, folder.totalItemCount);
      if (wellKnown.kind) {
        kindByFolderId.set(folder.id, wellKnown.kind);
        if (wellKnown.kind === "sent") sentFolderIds.add(folder.id);
      }
      if (wellKnown.name === "inbox") inboxTotal = folder.totalItemCount;
      if (wellKnown.name === "deleteditems") deletedItemsFolderId = folder.id;
      enqueue(folder, wellKnown.kind);
    }

    const firstPath = collectionPath("/me/mailFolders", {
      includeHiddenFolders: "true",
      "$select": "id,parentFolderId,childFolderCount,totalItemCount",
      "$top": "100"
    });

    for await (const page of this.pages<GraphFolder>(firstPath, signal, "folder_resolution")) {
      for (const folder of page.value) {
        const normalized = this.normalizeFolderResponse(folder);
        knownFolderIds.add(normalized.id);
        totalItemCountByFolderId.set(normalized.id, normalized.totalItemCount);
        enqueue(normalized, kindByFolderId.get(normalized.id));
      }
    }

    while (foldersToVisit.length > 0) {
      const parent = foldersToVisit.shift();
      if (!parent) break;
      const childPath = collectionPath(`/me/mailFolders/${encodeURIComponent(parent.id)}/childFolders`, {
        includeHiddenFolders: "true",
        "$select": "id,parentFolderId,childFolderCount,totalItemCount",
        "$top": "100"
      });
      for await (const page of this.pages<GraphFolder>(childPath, signal, "folder_resolution")) {
        for (const folder of page.value) {
          const normalized = this.normalizeFolderResponse(folder);
          knownFolderIds.add(normalized.id);
          totalItemCountByFolderId.set(normalized.id, normalized.totalItemCount);
          const kind = parent.inheritedKind;
          if (kind) {
            kindByFolderId.set(normalized.id, kind);
            if (kind === "sent") sentFolderIds.add(normalized.id);
          }
          enqueue(normalized, kind);
        }
      }
    }

    return {
      knownFolderIds,
      kindByFolderId,
      sentFolderIds,
      deletedItemsFolderId,
      inboxTotal,
      totalItemCountByFolderId
    };
  }

  private normalizeFolderResponse(folder: GraphFolder) {
    try {
      return normalizeFolder(folder);
    } catch (error) {
      this.graph.recordNonHttpFailure("folder_resolution", "invalid_shape");
      throw error;
    }
  }

  private async *pages<T>(
    firstPath: string,
    signal: AbortSignal | undefined,
    operation: MicrosoftGraphOperation
  ): AsyncIterable<GraphCollectionPage<T>> {
    let next: string | undefined = firstPath;
    while (next) {
      const value = await this.graph.getJson<unknown>(next, signal, operation);
      let page: GraphCollectionPage<T>;
      try {
        page = assertCollectionPage<T>(value);
      } catch (error) {
        this.graph.recordNonHttpFailure(operation, "invalid_shape");
        throw error;
      }
      this.graphPages += 1;
      if (operation === "main_message_scan") this.mainMessagePages += 1;
      yield page;
      next = page["@odata.nextLink"];
    }
  }
}

export function normalizeMicrosoftMessage(
  message: GraphMessage,
  folders: MicrosoftFolderIndex,
  subjectProtection = deriveSubjectProtection(typeof message.subject === "string" ? message.subject : undefined)
): NormalizedMailboxRecord {
  if (typeof message.id !== "string" || !message.id) throw new MicrosoftGraphMalformedResponseError();
  const sender = normalizeSender(message.from);
  const receivedAt = typeof message.receivedDateTime === "string" ? new Date(message.receivedDateTime) : new Date(Number.NaN);
  const hasValidReceivedAt = !Number.isNaN(receivedAt.getTime());
  const parentFolderId = typeof message.parentFolderId === "string" ? message.parentFolderId : undefined;
  const folderKind = parentFolderId ? folders.kindByFolderId.get(parentFolderId) : undefined;
  const flagStatus = normalizeFlagStatus(message.flag);
  const knownLocation = Boolean(parentFolderId && folders.knownFolderIds.has(parentFolderId));
  const headers = allowlistedHeaders(message.internetMessageHeaders);
  const categories = Array.isArray(message.categories)
    ? message.categories.filter((category): category is string => typeof category === "string" && category.length > 0)
    : [];

  return {
    providerMessageId: message.id,
    provider: "microsoft",
    senderAddress: sender.address,
    senderDisplayName: sender.displayName,
    senderDomain: sender.domain,
    receivedAt: hasValidReceivedAt ? receivedAt : new Date(),
    isRead: message.isRead === true,
    userLabels: categories,
    hasListUnsubscribe: Boolean(headers.get("list-unsubscribe")),
    listId: headers.get("list-id"),
    autoSubmitted: headers.get("auto-submitted")?.trim().toLowerCase(),
    precedence: headers.get("precedence")?.trim().toLowerCase(),
    isStarred: flagStatus === "flagged",
    isImportant: message.importance === "high",
    isSent: folderKind === "sent",
    isDraft: message.isDraft === true || folderKind === "draft",
    isDeleted: folderKind === "deleted",
    isExcludedMailboxLocation: folderKind === "deleted" || !knownLocation,
    hasUncertainMetadata:
      !sender.valid ||
      !hasValidReceivedAt ||
      typeof message.isRead !== "boolean" ||
      flagStatus === undefined,
    conversationId: typeof message.conversationId === "string" ? message.conversationId : undefined,
    subjectProtection
  };
}

function normalizeFlagStatus(input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  const flagStatus = (input as { flagStatus?: unknown }).flagStatus;
  return flagStatus === "flagged" || flagStatus === "notFlagged" || flagStatus === "complete"
    ? flagStatus
    : undefined;
}

function normalizeSender(input: unknown) {
  const fallback = {
    address: "unknown@unknown.invalid",
    displayName: undefined,
    domain: "unknown.invalid",
    valid: false
  };
  if (!input || typeof input !== "object") return fallback;
  const emailAddress = (input as { emailAddress?: unknown }).emailAddress;
  if (!emailAddress || typeof emailAddress !== "object") return fallback;
  const addressValue = (emailAddress as { address?: unknown }).address;
  if (typeof addressValue !== "string" || !addressValue.includes("@")) return fallback;
  const address = addressValue.trim().toLowerCase();
  const displayNameValue = (emailAddress as { name?: unknown }).name;
  return {
    address,
    displayName: typeof displayNameValue === "string" && displayNameValue.trim() ? displayNameValue.trim() : undefined,
    domain: address.split("@")[1],
    valid: true
  };
}

function allowlistedHeaders(input: unknown) {
  const result = new Map<string, string>();
  if (!Array.isArray(input)) return result;
  const allowed = new Set<string>(microsoftClassifierHeaderAllowlist);
  for (const header of input) {
    if (!header || typeof header !== "object") continue;
    const name = (header as { name?: unknown }).name;
    const value = (header as { value?: unknown }).value;
    if (typeof name !== "string" || typeof value !== "string") continue;
    const normalizedName = name.trim().toLowerCase();
    if (allowed.has(normalizedName) && !result.has(normalizedName)) result.set(normalizedName, value);
  }
  return result;
}

function normalizeFolder(folder: GraphFolder) {
  if (typeof folder.id !== "string" || !folder.id) throw new MicrosoftGraphMalformedResponseError();
  if (folder.childFolderCount !== undefined && (!Number.isInteger(folder.childFolderCount) || Number(folder.childFolderCount) < 0)) {
    throw new MicrosoftGraphMalformedResponseError();
  }
  return {
    id: folder.id,
    childFolderCount: typeof folder.childFolderCount === "number" ? folder.childFolderCount : 0,
    totalItemCount: typeof folder.totalItemCount === "number" && folder.totalItemCount >= 0 ? folder.totalItemCount : undefined
  };
}

const wellKnownFolders: ReadonlyArray<{ name: string; kind?: MicrosoftFolderKind }> = [
  { name: "inbox" },
  { name: "sentitems", kind: "sent" },
  { name: "drafts", kind: "draft" },
  { name: "deleteditems", kind: "deleted" }
];

function assertCollectionPage<T>(value: unknown): GraphCollectionPage<T> {
  if (!value || typeof value !== "object") throw new MicrosoftGraphMalformedResponseError();
  const page = value as { value?: unknown; "@odata.nextLink"?: unknown };
  if (!Array.isArray(page.value)) throw new MicrosoftGraphMalformedResponseError();
  if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") {
    throw new MicrosoftGraphMalformedResponseError();
  }
  return page as GraphCollectionPage<T>;
}

function boundedPageSize(batchSize: number) {
  if (!Number.isInteger(batchSize) || batchSize <= 0) return 100;
  return Math.min(250, batchSize);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

class AsyncResultQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly spaceWaiters: Array<() => void> = [];
  private ended = false;
  private error?: unknown;

  constructor(private readonly capacity: number) {}

  async push(value: T) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    while (!this.ended && this.values.length >= this.capacity) {
      await new Promise<void>((resolve) => this.spaceWaiters.push(resolve));
    }
    if (!this.ended) this.values.push(value);
  }

  close() {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.resolve({ value: undefined, done: true });
    while (this.spaceWaiters.length > 0) this.spaceWaiters.shift()?.();
  }

  fail(error: unknown) {
    this.error = error;
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()?.reject(error);
    while (this.spaceWaiters.length > 0) this.spaceWaiters.shift()?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          this.spaceWaiters.shift()?.();
          return Promise.resolve({ value, done: false });
        }
        if (this.error) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      }
    };
  }
}

function estimateGraphMessageBytes(message: GraphMessage) {
  const stringBytes = (value: unknown) => typeof value === "string" ? value.length * 2 : 0;
  const headers = Array.isArray(message.internetMessageHeaders)
    ? message.internetMessageHeaders.reduce((total, header) => {
        if (!header || typeof header !== "object") return total;
        const item = header as { name?: unknown; value?: unknown };
        return total + stringBytes(item.name) + stringBytes(item.value);
      }, 0)
    : 0;
  return 256 + headers +
    stringBytes(message.id) +
    stringBytes(message.conversationId) +
    stringBytes(message.receivedDateTime) +
    stringBytes(message.subject) +
    stringBytes(message.parentFolderId);
}

function folderIndexFromCleanupContext(context: MicrosoftCleanupSafetyContext): MicrosoftFolderIndex {
  return {
    knownFolderIds: new Set(context.knownFolderIds),
    kindByFolderId: new Map(context.kindByFolderId),
    sentFolderIds: new Set(context.sentFolderIds),
    deletedItemsFolderId: context.deletedItemsFolderId,
    totalItemCountByFolderId: new Map()
  };
}

function collectionPath(path: string, params: Record<string, string>) {
  const search = new URLSearchParams(params);
  return `${path}?${search.toString()}`;
}
