import "server-only";

const graphOrigin = "https://graph.microsoft.com";
const graphVersionPath = "/v1.0/";
const maxRetryDelayMs = 30_000;

export type MicrosoftGraphClientMetrics = {
  requests: number;
  subrequests: number;
  maxConcurrentRequests: number;
  throttleWaitMs: number;
  requestsByOperation: Partial<Record<MicrosoftGraphOperation, number>>;
  retries: number;
  tokenRefreshes: number;
  failures401: number;
  failures403: number;
  throttles429: number;
  failures5xx: number;
  other4xxFailures: number;
  lastOther4xxStatus?: number;
  lastOther4xxCategory?: MicrosoftGraph4xxCategory;
  lastOther4xxOperation?: MicrosoftGraphOperation;
  lastNonHttpFailureOperation?: MicrosoftGraphOperation;
  lastNonHttpFailureCategory?: MicrosoftGraphNonHttpFailureCategory;
};

export type MicrosoftGraphBatchRequest = {
  id: string;
  method: "GET" | "POST";
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: Readonly<Record<string, unknown>>;
  dependsOn?: string[];
};

export type MicrosoftGraphBatchResponse = {
  id: string;
  status: number;
  headers: Readonly<Record<string, unknown>>;
  body: unknown;
};

export type MicrosoftGraphOperation =
  | "folder_resolution"
  | "conversation_index"
  | "main_message_scan"
  | "header_enrichment"
  | "cleanup_safety_recheck"
  | "cleanup_move"
  | "cleanup_move_verify"
  | "cleanup_restore"
  | "cleanup_restore_verify";

export type MicrosoftGraphNonHttpFailureCategory =
  | "network"
  | "invalid_json"
  | "invalid_shape"
  | "normalization";

export type MicrosoftGraph4xxCategory =
  | "bad_request"
  | "not_found"
  | "method_not_allowed"
  | "request_timeout"
  | "conflict"
  | "gone"
  | "precondition_failed"
  | "payload_too_large"
  | "unsupported_media_type"
  | "unprocessable_content"
  | "other_client_error";

export type MicrosoftGraphClientOptions = {
  accessToken: string;
  refreshAccessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxRetries?: number;
  requestCoordinator?: <T>(request: () => Promise<T>) => Promise<T>;
  random?: () => number;
};

export class MicrosoftGraphClient {
  private accessToken: string;
  private readonly refreshAccessToken?: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxRetries: number;
  private readonly requestCoordinator?: <T>(request: () => Promise<T>) => Promise<T>;
  private readonly random: () => number;
  private activeRequests = 0;
  private readonly metrics: MicrosoftGraphClientMetrics = {
    requests: 0,
    subrequests: 0,
    maxConcurrentRequests: 0,
    throttleWaitMs: 0,
    requestsByOperation: {},
    retries: 0,
    tokenRefreshes: 0,
    failures401: 0,
    failures403: 0,
    throttles429: 0,
    failures5xx: 0,
    other4xxFailures: 0
  };

  constructor(options: MicrosoftGraphClientOptions) {
    if (!options.accessToken) throw new MicrosoftGraphReconnectRequiredError();
    this.accessToken = options.accessToken;
    this.refreshAccessToken = options.refreshAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? wait;
    this.maxRetries = options.maxRetries ?? 3;
    this.requestCoordinator = options.requestCoordinator;
    this.random = options.random ?? Math.random;
  }

  getMetrics(): MicrosoftGraphClientMetrics {
    return {
      ...this.metrics,
      requestsByOperation: { ...this.metrics.requestsByOperation }
    };
  }

  recordNonHttpFailure(
    operation: MicrosoftGraphOperation,
    category: MicrosoftGraphNonHttpFailureCategory
  ) {
    this.metrics.lastNonHttpFailureOperation = operation;
    this.metrics.lastNonHttpFailureCategory = category;
  }

  async getJson<T>(
    pathOrNextLink: string,
    signal?: AbortSignal,
    operation?: MicrosoftGraphOperation
  ): Promise<T> {
    let url: URL;
    try {
      url = toTrustedGraphUrl(pathOrNextLink);
    } catch (error) {
      if (operation) this.recordNonHttpFailure(operation, "invalid_shape");
      throw error;
    }
    let transientAttempts = 0;
    let refreshedAfterUnauthorized = false;

    while (true) {
      let response: Response;
      this.recordRequest(operation, 1);
      try {
        response = await this.fetchRequest(() => this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.accessToken}`
          },
          signal
        }));
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (transientAttempts >= this.maxRetries) {
          if (operation) this.recordNonHttpFailure(operation, "network");
          throw new MicrosoftGraphUnavailableError();
        }
        transientAttempts += 1;
        this.metrics.retries += 1;
        await this.sleep(backoffMs(transientAttempts, this.random), signal);
        continue;
      }

      this.recordResponseStatus(response.status, operation);

      if (response.status === 401 && !refreshedAfterUnauthorized && this.refreshAccessToken) {
        refreshedAfterUnauthorized = true;
        try {
          const refreshedToken = await this.refreshAccessToken();
          if (!refreshedToken) throw new Error("Missing refreshed token.");
          this.accessToken = refreshedToken;
          this.metrics.tokenRefreshes += 1;
          continue;
        } catch {
          throw new MicrosoftGraphReconnectRequiredError();
        }
      }
      if (response.status === 401) throw new MicrosoftGraphReconnectRequiredError();
      if (response.status === 403) throw new MicrosoftGraphPermissionError();

      if (response.status === 429 || response.status >= 500) {
        if (transientAttempts >= this.maxRetries) {
          throw new MicrosoftGraphUnavailableError(response.status);
        }
        transientAttempts += 1;
        this.metrics.retries += 1;
        const retryAfter = retryAfterMs(response.headers.get("retry-after"));
        const waitMs = retryAfter ?? backoffMs(transientAttempts, this.random);
        if (response.status === 429) this.metrics.throttleWaitMs += waitMs;
        await this.sleep(waitMs, signal);
        continue;
      }

      if (!response.ok) {
        throw new MicrosoftGraphClientResponseError(
          response.status,
          graph4xxCategory(response.status)
        );
      }
      try {
        return (await response.json()) as T;
      } catch {
        if (operation) this.recordNonHttpFailure(operation, "invalid_json");
        throw new MicrosoftGraphMalformedResponseError();
      }
    }
  }

  async postJson<T>(
    path: string,
    body: Readonly<Record<string, string>>,
    operation: Extract<MicrosoftGraphOperation, "cleanup_move" | "cleanup_restore">
  ): Promise<{ status: number; value: T }> {
    const url = toTrustedGraphUrl(path);
    let response: Response;
    this.recordRequest(operation, 1);
    try {
      response = await this.fetchRequest(() => this.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }));
    } catch {
      this.recordNonHttpFailure(operation, "network");
      throw new MicrosoftGraphMutationUncertainError();
    }

    this.recordResponseStatus(response.status, operation);
    if (!response.ok) {
      throw new MicrosoftGraphMutationRejectedError(response.status);
    }

    try {
      return { status: response.status, value: (await response.json()) as T };
    } catch {
      this.recordNonHttpFailure(operation, "invalid_json");
      throw new MicrosoftGraphMutationUncertainError();
    }
  }

  async batchJson(
    requests: readonly MicrosoftGraphBatchRequest[],
    operation: MicrosoftGraphOperation,
    input: { mutation: boolean }
  ): Promise<MicrosoftGraphBatchResponse[]> {
    assertBatchRequests(requests);
    const url = toTrustedGraphUrl("/$batch");
    let response: Response;
    this.recordRequest(operation, requests.length);
    try {
      response = await this.fetchRequest(() => this.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ requests })
      }));
    } catch {
      this.recordNonHttpFailure(operation, "network");
      if (input.mutation) throw new MicrosoftGraphMutationUncertainError();
      throw new MicrosoftGraphUnavailableError();
    }

    this.recordResponseStatus(response.status, operation);
    if (!response.ok) {
      if (input.mutation) throw new MicrosoftGraphMutationUncertainError();
      if (response.status === 401) throw new MicrosoftGraphReconnectRequiredError();
      if (response.status === 403) throw new MicrosoftGraphPermissionError();
      throw new MicrosoftGraphUnavailableError(response.status);
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      this.recordNonHttpFailure(operation, "invalid_json");
      if (input.mutation) throw new MicrosoftGraphMutationUncertainError();
      throw new MicrosoftGraphMalformedResponseError();
    }
    let responses: MicrosoftGraphBatchResponse[];
    try {
      responses = normalizeBatchResponses(value, requests);
    } catch {
      this.recordNonHttpFailure(operation, "invalid_shape");
      if (input.mutation) throw new MicrosoftGraphMutationUncertainError();
      throw new MicrosoftGraphMalformedResponseError();
    }
    for (const item of responses) this.recordResponseStatus(item.status, operation);
    return responses;
  }

  private recordResponseStatus(status: number, operation?: MicrosoftGraphOperation) {
    if (status === 401) this.metrics.failures401 += 1;
    if (status === 403) this.metrics.failures403 += 1;
    if (status === 429) this.metrics.throttles429 += 1;
    if (status >= 500) this.metrics.failures5xx += 1;
    if (isOther4xx(status)) {
      this.metrics.other4xxFailures += 1;
      this.metrics.lastOther4xxStatus = status;
      this.metrics.lastOther4xxCategory = graph4xxCategory(status);
      this.metrics.lastOther4xxOperation = operation;
    }
  }

  private recordRequest(operation: MicrosoftGraphOperation | undefined, subrequests: number) {
    this.metrics.requests += 1;
    this.metrics.subrequests += subrequests;
    if (operation) {
      this.metrics.requestsByOperation[operation] = (this.metrics.requestsByOperation[operation] ?? 0) + 1;
    }
  }

  private fetchRequest(request: () => Promise<Response>) {
    const measured = async () => {
      this.activeRequests += 1;
      this.metrics.maxConcurrentRequests = Math.max(this.metrics.maxConcurrentRequests, this.activeRequests);
      try {
        return await request();
      } finally {
        this.activeRequests -= 1;
      }
    };
    return this.requestCoordinator ? this.requestCoordinator(measured) : measured();
  }
}

function assertBatchRequests(requests: readonly MicrosoftGraphBatchRequest[]) {
  if (requests.length < 1 || requests.length > 20) throw new MicrosoftGraphMalformedResponseError();
  const ids = new Set<string>();
  for (const request of requests) {
    if (!request.id || ids.has(request.id)) throw new MicrosoftGraphMalformedResponseError();
    ids.add(request.id);
    const trusted = toTrustedGraphUrl(request.url);
    if (trusted.pathname === `${graphVersionPath}$batch`) throw new MicrosoftGraphMalformedResponseError();
    if (request.dependsOn?.some((id) => !ids.has(id))) throw new MicrosoftGraphMalformedResponseError();
    if (request.body) {
      const contentType = Object.entries(request.headers ?? {})
        .find(([name]) => name.toLowerCase() === "content-type")?.[1];
      if (contentType !== "application/json") throw new MicrosoftGraphMalformedResponseError();
    }
  }
}

function normalizeBatchResponses(
  value: unknown,
  requests: readonly MicrosoftGraphBatchRequest[]
): MicrosoftGraphBatchResponse[] {
  if (!value || typeof value !== "object") throw new MicrosoftGraphMalformedResponseError();
  const rawResponses = (value as { responses?: unknown }).responses;
  if (!Array.isArray(rawResponses) || rawResponses.length !== requests.length) {
    throw new MicrosoftGraphMalformedResponseError();
  }
  const byId = new Map<string, MicrosoftGraphBatchResponse>();
  for (const raw of rawResponses) {
    if (!raw || typeof raw !== "object") throw new MicrosoftGraphMalformedResponseError();
    const item = raw as { id?: unknown; status?: unknown; headers?: unknown; body?: unknown };
    if (typeof item.id !== "string" || !Number.isInteger(item.status) || byId.has(item.id)) {
      throw new MicrosoftGraphMalformedResponseError();
    }
    byId.set(item.id, {
      id: item.id,
      status: Number(item.status),
      headers: item.headers && typeof item.headers === "object" ? item.headers as Readonly<Record<string, unknown>> : {},
      body: item.body
    });
  }
  return requests.map((request) => {
    const response = byId.get(request.id);
    if (!response) throw new MicrosoftGraphMalformedResponseError();
    return response;
  });
}

export function toTrustedGraphUrl(pathOrNextLink: string): URL {
  let url: URL;
  try {
    url = pathOrNextLink.startsWith("/")
      ? new URL(pathOrNextLink.replace(/^\/+/, ""), `${graphOrigin}${graphVersionPath}`)
      : new URL(pathOrNextLink);
  } catch {
    throw new MicrosoftGraphPaginationError();
  }

  if (url.protocol !== "https:" || url.origin !== graphOrigin || !url.pathname.startsWith(graphVersionPath)) {
    throw new MicrosoftGraphPaginationError();
  }
  return url;
}

export class MicrosoftGraphScanError extends Error {
  constructor(message = "Outlook could not be scanned. Try again.") {
    super(message);
    this.name = "MicrosoftGraphScanError";
  }
}

export class MicrosoftGraphClientResponseError extends MicrosoftGraphScanError {
  readonly status: number;
  readonly category: MicrosoftGraph4xxCategory;

  constructor(status: number, category: MicrosoftGraph4xxCategory) {
    super(`Outlook scan request was rejected by Microsoft Graph (HTTP ${status}, ${category}).`);
    this.name = "MicrosoftGraphClientResponseError";
    this.status = status;
    this.category = category;
  }
}

export class MicrosoftGraphReconnectRequiredError extends MicrosoftGraphScanError {
  constructor() {
    super("Microsoft needs to reconnect before Outlook can be scanned.");
    this.name = "MicrosoftGraphReconnectRequiredError";
  }
}

export class MicrosoftGraphPermissionError extends MicrosoftGraphScanError {
  constructor() {
    super("Microsoft mail access was not granted. Reconnect Microsoft and approve mail access.");
    this.name = "MicrosoftGraphPermissionError";
  }
}

export class MicrosoftGraphUnavailableError extends MicrosoftGraphScanError {
  readonly status?: number;

  constructor(status?: number) {
    super("Outlook is temporarily unavailable. Try scanning again.");
    this.name = "MicrosoftGraphUnavailableError";
    this.status = status;
  }
}

export class MicrosoftGraphMalformedResponseError extends MicrosoftGraphScanError {
  constructor() {
    super("Outlook returned an unexpected response. No mailbox changes were made.");
    this.name = "MicrosoftGraphMalformedResponseError";
  }
}

export class MicrosoftGraphPaginationError extends MicrosoftGraphScanError {
  constructor() {
    super("Outlook scan pagination could not be verified. No mailbox changes were made.");
    this.name = "MicrosoftGraphPaginationError";
  }
}

export class MicrosoftGraphMutationRejectedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Microsoft Graph rejected the Outlook cleanup operation.");
    this.name = "MicrosoftGraphMutationRejectedError";
    this.status = status;
  }
}

export class MicrosoftGraphMutationUncertainError extends Error {
  constructor() {
    super("The Outlook cleanup operation returned an uncertain result.");
    this.name = "MicrosoftGraphMutationUncertainError";
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(maxRetryDelayMs, Math.round(seconds * 1000));
}

function backoffMs(attempt: number, random: () => number) {
  const base = 500 * 2 ** (attempt - 1);
  return Math.min(maxRetryDelayMs, Math.round(base + base * 0.25 * random()));
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isOther4xx(status: number) {
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}

function graph4xxCategory(status: number): MicrosoftGraph4xxCategory {
  if (status === 400) return "bad_request";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 408) return "request_timeout";
  if (status === 409) return "conflict";
  if (status === 410) return "gone";
  if (status === 412) return "precondition_failed";
  if (status === 413) return "payload_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 422) return "unprocessable_content";
  return "other_client_error";
}
