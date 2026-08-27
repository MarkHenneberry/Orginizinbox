import "server-only";
import {
  classifyGmailErrorResponse,
  classifyGmailErrorStatus,
  classifyGmailTransportError,
  inferGmailProviderErrorReason,
  type GmailProviderErrorReason,
  type GmailProviderFailure
} from "@/lib/providers/gmail/api-error-classification";
import {
  addGmailCleanupExclusions,
  assessGmailApiCleanupCandidate,
  assessGmailMutableLabels,
  buildGmailSenderCleanupQuery,
  createGmailCleanupExclusionCounts,
  type GmailCleanupCandidate,
  type GmailCleanupExclusionCounts,
  type GmailMinimalMessageMetadata
} from "@/lib/providers/gmail/cleanup-candidates";
import {
  calculateGmailQuotaUnits,
  createGmailRequestCounts,
  type GmailRequestCounts,
  type GmailRequestKind
} from "@/lib/providers/gmail/quota";
import { assertTrashAccounting } from "@/lib/providers/gmail/trash-utils";

const gmailApiBaseUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const gmailMinimalMetadataFields = "id,threadId,labelIds,internalDate,sizeEstimate,payload(headers(name,value))";
const gmailVerificationFields = "id,labelIds";
const gmailCleanupHeaderAllowlist = ["From", "List-Id", "List-Unsubscribe", "Auto-Submitted", "Precedence", "Subject"] as const;
const controlledCleanupHardMaximum = 100;
const defaultRequestConcurrency = 8;
const defaultRetryAttempts = 4;

export type GmailRequestProfile = {
  requestCount: number;
  retryCount: number;
  peakConcurrency: number;
  durationP50Ms: number;
  durationP95Ms: number;
  estimatedQuotaUnits: number;
  requests: GmailRequestCounts;
};

export type GmailCandidateResolutionResult = {
  candidates: GmailCleanupCandidate[];
  exclusionCounts: GmailCleanupExclusionCounts;
  excludedMessageCount: number;
  candidateResolutionMs: number;
  previewSafetyCheckMs: number;
};

type GmailListResponse = {
  messages: Array<{ id: string }>;
  nextPageToken?: string;
};

export type GmailCandidateRecheckGroup = {
  senderAddress: string;
  candidates: GmailCleanupCandidate[];
};

export type GmailCandidateRecheckResult = {
  eligibleIds: string[];
  exclusionCounts: GmailCleanupExclusionCounts;
  excludedMessageCount: number;
  finalSafetyRecheckMs: number;
};

export type GmailStateVerificationResult = {
  attemptedCount: number;
  verifiedCount: number;
  failedCount: number;
  uncertainCount: number;
  durationMs: number;
  verifiedIds: string[];
  failedIds: string[];
  uncertainIds: string[];
};

export type GmailUndoVerificationResult = GmailStateVerificationResult & {
  untrashMs: number;
  fallbackVerificationCount: number;
  fallbackVerificationMs: number;
};

export type GmailTrashClientOptions = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  requestConcurrency?: number;
  verificationConcurrency?: number;
  retryAttempts?: number;
  requestTimeoutMs?: number;
};

export class GmailApiRequestError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
    readonly reason: GmailProviderErrorReason = inferGmailProviderErrorReason(status, transient),
    readonly retryable = transient,
    readonly retriesAttempted = 0
  ) {
    super(message);
    this.name = "GmailApiRequestError";
  }
}

export class GmailCandidateResolutionStageError extends Error {
  constructor(
    readonly stage: "query" | "list" | "metadata",
    readonly cause: unknown,
    readonly candidateResolutionMs: number,
    readonly previewSafetyCheckMs: number
  ) {
    super(`Gmail candidate resolution failed during ${stage}.`);
    this.name = "GmailCandidateResolutionStageError";
  }
}

export class GmailTrashClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly requestConcurrency: number;
  private readonly verificationConcurrency: number;
  private readonly retryAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly requestCounts = createGmailRequestCounts();
  private readonly requestDurations: number[] = [];
  private readonly requestQueue: Array<() => void> = [];
  private readonly responseRetryAttempts = new WeakMap<Response, number>();
  private activeRequests = 0;
  private peakConcurrency = 0;
  private retryCount = 0;

  constructor(
    private readonly accessToken: string,
    options: GmailTrashClientOptions = {}
  ) {
    if (!accessToken) throw new Error("Missing Gmail API access token.");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.requestConcurrency = clampConcurrency(options.requestConcurrency ?? defaultRequestConcurrency);
    this.verificationConcurrency = clampConcurrency(options.verificationConcurrency ?? this.requestConcurrency);
    this.retryAttempts = Math.max(1, Math.min(options.retryAttempts ?? defaultRetryAttempts, defaultRetryAttempts));
    this.requestTimeoutMs = Math.max(1, Math.min(options.requestTimeoutMs ?? 10_000, 30_000));
  }

  getRequestProfile(): GmailRequestProfile {
    const sortedDurations = [...this.requestDurations].sort((first, second) => first - second);
    return {
      requestCount: Object.values(this.requestCounts).reduce((total, count) => total + count, 0),
      retryCount: this.retryCount,
      peakConcurrency: this.peakConcurrency,
      durationP50Ms: percentile(sortedDurations, 0.5),
      durationP95Ms: percentile(sortedDurations, 0.95),
      estimatedQuotaUnits: calculateGmailQuotaUnits(this.requestCounts),
      requests: { ...this.requestCounts }
    };
  }

  async resolveCleanupCandidatesForSender(input: {
    senderAddress: string;
    limit: number;
    participatedConversationIds: ReadonlySet<string>;
    protectedSenders?: ReadonlySet<string>;
    now?: Date;
  }): Promise<GmailCandidateResolutionResult> {
    assertControlledCount(input.limit);
    const candidates: GmailCleanupCandidate[] = [];
    const exclusionCounts = createGmailCleanupExclusionCounts();
    const inspectedIds = new Set<string>();
    let excludedMessageCount = 0;
    let candidateResolutionMs = 0;
    let previewSafetyCheckMs = 0;
    let pageToken: string | undefined;
    let query: string;
    try {
      query = buildGmailSenderCleanupQuery({ senderAddress: input.senderAddress, now: input.now });
    } catch (error) {
      throw new GmailCandidateResolutionStageError("query", error, 0, 0);
    }

    do {
      const listStartedAt = performance.now();
      let listed: GmailListResponse;
      try {
        listed = await this.listMessages({
          query,
          pageToken,
          maxResults: Math.min(100, Math.max(1, input.limit - candidates.length))
        });
      } catch (error) {
        candidateResolutionMs += performance.now() - listStartedAt;
        throw new GmailCandidateResolutionStageError(
          "list",
          error,
          Math.round(candidateResolutionMs),
          Math.round(previewSafetyCheckMs)
        );
      }
      candidateResolutionMs += performance.now() - listStartedAt;

      const pageIds = unique(listed.messages.flatMap((item) => (!inspectedIds.has(item.id) ? [item.id] : [])));
      pageIds.forEach((id) => inspectedIds.add(id));
      const safetyStartedAt = performance.now();
      let assessed: Array<{
        metadata: GmailMinimalMessageMetadata;
        assessment: ReturnType<typeof assessGmailApiCleanupCandidate>;
      }>;
      try {
        assessed = await mapWithConcurrency(
          pageIds,
          this.requestConcurrency,
          async (id) => {
            const metadata = await this.getMinimalMessageMetadata(id);
            return {
              metadata,
              assessment: assessGmailApiCleanupCandidate(metadata, {
                expectedSenderAddress: input.senderAddress,
                participatedConversationIds: input.participatedConversationIds,
                protectedSenders: input.protectedSenders,
                now: input.now
              })
            };
          }
        );
      } catch (error) {
        previewSafetyCheckMs += performance.now() - safetyStartedAt;
        throw new GmailCandidateResolutionStageError(
          "metadata",
          error,
          Math.round(candidateResolutionMs),
          Math.round(previewSafetyCheckMs)
        );
      }
      previewSafetyCheckMs += performance.now() - safetyStartedAt;

      for (const { metadata, assessment } of assessed) {
        if (assessment.eligible && candidates.length < input.limit) {
          candidates.push({
            apiMessageId: metadata.id,
            requiresMutableStrongEvidenceRecheck: assessment.reliesOnMutableCategoryEvidence
          });
        } else if (!assessment.eligible) {
          excludedMessageCount += 1;
          addGmailCleanupExclusions(exclusionCounts, assessment.exclusionReasons);
        }
      }
      pageToken = listed.nextPageToken;
    } while (pageToken && candidates.length < input.limit);

    return {
      candidates,
      exclusionCounts,
      excludedMessageCount,
      candidateResolutionMs: Math.round(candidateResolutionMs),
      previewSafetyCheckMs: Math.round(previewSafetyCheckMs)
    };
  }

  async recheckCleanupCandidates(groups: GmailCandidateRecheckGroup[], now?: Date): Promise<GmailCandidateRecheckResult> {
    const eligibleIds: string[] = [];
    const exclusionCounts = createGmailCleanupExclusionCounts();
    let excludedMessageCount = 0;
    const startedAt = performance.now();

    await mapWithConcurrency(
      groups,
      this.requestConcurrency,
      async (group) => {
        const listed = await this.listMessages({
          query: buildGmailSenderCleanupQuery({ senderAddress: group.senderAddress, now }),
          maxResults: 500
        });
        const currentSearchIds = new Set(listed.messages.map((message) => message.id));

        await mapWithConcurrency(
          group.candidates,
          this.requestConcurrency,
          async (candidate) => {
            const listedNow = currentSearchIds.has(candidate.apiMessageId);
            if (listedNow && !candidate.requiresMutableStrongEvidenceRecheck) {
              eligibleIds.push(candidate.apiMessageId);
              return;
            }

            const labels = await this.getMessageLabels(candidate.apiMessageId, "confirmationLabels");
            const reasons = labels
              ? assessGmailMutableLabels(labels, candidate.requiresMutableStrongEvidenceRecheck)
              : ["OTHER" as const];
            if (!listedNow && reasons.length === 0) reasons.push("OTHER");
            if (reasons.length === 0) {
              eligibleIds.push(candidate.apiMessageId);
            } else {
              excludedMessageCount += 1;
              addGmailCleanupExclusions(exclusionCounts, reasons);
            }
          }
        );
      }
    );

    return {
      eligibleIds,
      exclusionCounts,
      excludedMessageCount,
      finalSafetyRecheckMs: Math.round(performance.now() - startedAt)
    };
  }

  async batchModifyTrash(apiMessageIds: string[]) {
    const ids = unique(apiMessageIds);
    assertControlledCount(ids.length);
    await this.fetchWithRetry(
      `${gmailApiBaseUrl}/batchModify`,
      { method: "POST", body: JSON.stringify({ ids, addLabelIds: ["TRASH"], removeLabelIds: [] }) },
      "batchModify"
    );
  }

  async verifyMessagesInTrash(apiMessageIds: string[]): Promise<GmailStateVerificationResult> {
    return this.verifyTrashState(apiMessageIds, true);
  }

  async untrashAndVerifyMessages(apiMessageIds: string[]): Promise<GmailUndoVerificationResult> {
    const ids = unique(apiMessageIds);
    assertControlledCount(ids.length);
    const startedAt = performance.now();
    const untrashStartedAt = performance.now();
    const initialOutcomes = await mapWithConcurrency(ids, this.verificationConcurrency, async (id) => {
      let response: Response;
      try {
        response = await this.fetchWithRetry(
          `${gmailApiBaseUrl}/${encodeURIComponent(id)}/untrash?fields=id,labelIds`,
          { method: "POST" },
          "untrash"
        );
      } catch (error) {
        return error instanceof GmailApiRequestError && !error.transient ? "failed" : "uncertain";
      }

      const responseLabels = await readResponseLabels(response);
      if (responseLabels) return responseLabels.has("TRASH") ? "failed" : "verified";
      return "fallback";
    });
    const untrashMs = Math.round(performance.now() - untrashStartedAt);
    const fallbackIndices = initialOutcomes.flatMap((outcome, index) => (outcome === "fallback" ? [index] : []));
    const fallbackStartedAt = performance.now();
    const fallbackOutcomes = await mapWithConcurrency(fallbackIndices, this.verificationConcurrency, async (index) => {
      try {
        const fallbackLabels = await this.getMessageLabels(ids[index], "undoFallbackLabels");
        if (!fallbackLabels) return "uncertain";
        return fallbackLabels.has("TRASH") ? "failed" : "verified";
      } catch (error) {
        return error instanceof GmailApiRequestError && !error.transient ? "failed" : "uncertain";
      }
    });
    const fallbackVerificationMs = Math.round(performance.now() - fallbackStartedAt);
    const outcomes = [...initialOutcomes];
    fallbackIndices.forEach((messageIndex, fallbackIndex) => {
      outcomes[messageIndex] = fallbackOutcomes[fallbackIndex];
    });
    const result = {
      attemptedCount: ids.length,
      verifiedCount: outcomes.filter((outcome) => outcome === "verified").length,
      failedCount: outcomes.filter((outcome) => outcome === "failed").length,
      uncertainCount: outcomes.filter((outcome) => outcome === "uncertain").length,
      durationMs: Math.round(performance.now() - startedAt),
      verifiedIds: ids.filter((_, index) => outcomes[index] === "verified"),
      failedIds: ids.filter((_, index) => outcomes[index] === "failed"),
      uncertainIds: ids.filter((_, index) => outcomes[index] === "uncertain"),
      untrashMs,
      fallbackVerificationCount: fallbackIndices.length,
      fallbackVerificationMs
    };
    assertTrashAccounting(result);
    return result;
  }

  async getMinimalMessageMetadata(id: string): Promise<GmailMinimalMessageMetadata> {
    const params = new URLSearchParams({ format: "metadata", fields: gmailMinimalMetadataFields });
    gmailCleanupHeaderAllowlist.forEach((header) => params.append("metadataHeaders", header));
    const response = await this.fetchWithRetry(
      `${gmailApiBaseUrl}/${encodeURIComponent(id)}?${params.toString()}`,
      { method: "GET" },
      "previewMetadata"
    );
    const message = (await this.readJsonResponse(response)) as GmailMinimalMessageMetadata & {
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    return {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds,
      internalDate: message.internalDate,
      sizeEstimate: message.sizeEstimate,
      headers: message.payload?.headers
    };
  }

  private async verifyTrashState(apiMessageIds: string[], expectedTrashed: boolean) {
    const ids = unique(apiMessageIds);
    assertControlledCount(ids.length);
    const startedAt = performance.now();
    const outcomes = await mapWithConcurrency(ids, this.verificationConcurrency, async (id) => {
      try {
        const labels = await this.getMessageLabels(id, "verificationLabels");
        if (!labels) return "uncertain";
        return labels.has("TRASH") === expectedTrashed ? "verified" : "failed";
      } catch (error) {
        return error instanceof GmailApiRequestError && !error.transient ? "failed" : "uncertain";
      }
    });
    const result = {
      attemptedCount: ids.length,
      verifiedCount: outcomes.filter((outcome) => outcome === "verified").length,
      failedCount: outcomes.filter((outcome) => outcome === "failed").length,
      uncertainCount: outcomes.filter((outcome) => outcome === "uncertain").length,
      durationMs: Math.round(performance.now() - startedAt),
      verifiedIds: ids.filter((_, index) => outcomes[index] === "verified"),
      failedIds: ids.filter((_, index) => outcomes[index] === "failed"),
      uncertainIds: ids.filter((_, index) => outcomes[index] === "uncertain")
    };
    assertTrashAccounting(result);
    return result;
  }

  private async getMessageLabels(
    id: string,
    kind: "confirmationLabels" | "verificationLabels" | "undoFallbackLabels"
  ) {
    const params = new URLSearchParams({ format: "metadata", fields: gmailVerificationFields });
    const response = await this.fetchWithRetry(
      `${gmailApiBaseUrl}/${encodeURIComponent(id)}?${params.toString()}`,
      { method: "GET" },
      kind
    );
    const message = (await this.readJsonResponse(response)) as { labelIds?: string[] };
    return Array.isArray(message.labelIds)
      ? new Set(message.labelIds.map((label) => label.toUpperCase()))
      : undefined;
  }

  private async listMessages(input: {
    query: string;
    pageToken?: string;
    maxResults: number;
  }): Promise<GmailListResponse> {
    const params = new URLSearchParams({
      q: input.query,
      maxResults: String(input.maxResults),
      fields: "messages/id,nextPageToken"
    });
    if (input.pageToken) params.set("pageToken", input.pageToken);
    const response = await this.fetchWithRetry(`${gmailApiBaseUrl}?${params.toString()}`, { method: "GET" }, "list");
    if (response.status === 204) return { messages: [] };
    return parseGmailListResponse(await this.readJsonResponse(response), () => this.invalidResponseError(response));
  }

  private async fetchWithRetry(url: string, init: RequestInit, kind: GmailRequestKind): Promise<Response> {
    let lastFailure: GmailProviderFailure | undefined;
    for (let attempt = 0; attempt < this.retryAttempts; attempt += 1) {
      if (attempt > 0) this.retryCount += 1;
      let response: Response | undefined;
      try {
        response = await this.executeRequest(url, init, kind);
      } catch (error) {
        lastFailure = classifyGmailTransportError(error);
      }

      if (response?.ok) {
        this.responseRetryAttempts.set(response, attempt);
        return response;
      }
      if (response) {
        try {
          lastFailure = await classifyGmailErrorResponse(response);
        } catch {
          lastFailure = classifyGmailErrorStatus(response.status);
        }
      }

      const failure = lastFailure ?? classifyGmailTransportError(undefined);
      if (!failure.retryable) throw gmailRequestError(failure, attempt);
      if (attempt < this.retryAttempts - 1) await this.sleepImpl(backoffMs(attempt));
    }
    throw gmailRequestError(lastFailure ?? classifyGmailTransportError(undefined), this.retryAttempts - 1);
  }

  private async readJsonResponse(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw this.invalidResponseError(response);
    }
  }

  private invalidResponseError(response: Response) {
    return new GmailApiRequestError(
      "Gmail provider returned an invalid response.",
      false,
      response.status,
      "GMAIL_RESPONSE_INVALID",
      false,
      this.responseRetryAttempts.get(response) ?? 0
    );
  }

  private async executeRequest(url: string, init: RequestInit, kind: GmailRequestKind) {
    await this.acquireRequestSlot();
    const startedAt = performance.now();
    this.requestCounts[kind] += 1;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        return await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
            ...init.headers
          }
        });
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      this.requestDurations.push(Math.round(performance.now() - startedAt));
      this.releaseRequestSlot();
    }
  }

  private async acquireRequestSlot() {
    if (this.activeRequests >= this.requestConcurrency) {
      await new Promise<void>((resolve) => this.requestQueue.push(resolve));
    }
    this.activeRequests += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.activeRequests);
  }

  private releaseRequestSlot() {
    this.activeRequests -= 1;
    this.requestQueue.shift()?.();
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(clampConcurrency(concurrency), values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function unique(ids: string[]) {
  return [...new Set(ids)];
}

function parseGmailListResponse(value: unknown, invalid: () => GmailApiRequestError): GmailListResponse {
  if (!isRecord(value)) throw invalid();
  const rawMessages = value.messages;
  const rawNextPageToken = value.nextPageToken;
  if (rawNextPageToken !== undefined && typeof rawNextPageToken !== "string") throw invalid();
  if (rawMessages === undefined) {
    return { messages: [], nextPageToken: rawNextPageToken as string | undefined };
  }
  if (!Array.isArray(rawMessages)) throw invalid();

  const messages = rawMessages.map((message) => {
    if (!isRecord(message) || typeof message.id !== "string" || !message.id) throw invalid();
    return { id: message.id };
  });
  return { messages, nextPageToken: rawNextPageToken as string | undefined };
}

async function readResponseLabels(response: Response) {
  try {
    const message = (await response.json()) as { labelIds?: string[] };
    return Array.isArray(message.labelIds)
      ? new Set(message.labelIds.map((label) => label.toUpperCase()))
      : undefined;
  } catch {
    return undefined;
  }
}

function assertControlledCount(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > controlledCleanupHardMaximum) {
    throw new Error(`Controlled Gmail cleanup requires between 1 and ${controlledCleanupHardMaximum} messages.`);
  }
}

function clampConcurrency(value: number) {
  return Math.max(1, Math.min(Math.floor(value), 10));
}

function percentile(sortedValues: number[], percentileValue: number) {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.ceil(percentileValue * sortedValues.length) - 1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function gmailRequestError(failure: GmailProviderFailure, retriesAttempted: number) {
  return new GmailApiRequestError(
    failure.retryable ? "Gmail provider request failed after bounded retries." : "Gmail provider request failed.",
    failure.retryable,
    failure.status,
    failure.reason,
    failure.retryable,
    retriesAttempted
  );
}

function backoffMs(attempt: number) {
  return 200 * 2 ** attempt + Math.floor(Math.random() * 75);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
