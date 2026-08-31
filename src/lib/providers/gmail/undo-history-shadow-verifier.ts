import "server-only";

const gmailApiBaseUrl = "https://gmail.googleapis.com/gmail/v1/users/me";
const maximumFallbackReads = 10;

export type GmailUndoHistoryShadowMetrics = {
  getProfileRequests: number;
  historyListRequests: number;
  historyPages: number;
  historyPollAttempts: number;
  getFallbackRequests: number;
  retryRequests: number;
};

export type GmailUndoHistoryShadowResult = {
  targetCount: number;
  verifiedByHistory: number;
  verifiedByGetFallback: number;
  unresolvedCount: number;
  mismatchWithPrimaryCount: number;
  historyUnavailable: boolean;
  historyWallTimeMs: number;
  metrics: GmailUndoHistoryShadowMetrics;
};

export type GmailUndoHistoryShadowOptions = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  retryAttempts?: number;
  requestTimeoutMs?: number;
};

export class GmailUndoHistoryShadowVerifier {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly pollAttempts: number;
  private readonly retryAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly metrics = createMetrics();

  constructor(
    private readonly accessToken: string,
    options: GmailUndoHistoryShadowOptions = {}
  ) {
    if (!accessToken) throw new Error("Missing Gmail access token for Undo history shadow verification.");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.pollAttempts = clamp(options.pollAttempts ?? 3, 1, 5);
    this.retryAttempts = clamp(options.retryAttempts ?? 3, 1, 4);
    this.requestTimeoutMs = clamp(options.requestTimeoutMs ?? 10_000, 1, 30_000);
  }

  async captureStartHistoryId() {
    const response = await this.request(`${gmailApiBaseUrl}/profile?fields=historyId`, "getProfileRequests");
    const body = await readJson(response) as { historyId?: string };
    if (!body.historyId || !/^\d+$/.test(body.historyId)) {
      throw new Error("Gmail profile did not provide a valid Undo history checkpoint.");
    }
    return body.historyId;
  }

  getMetrics() {
    return { ...this.metrics };
  }

  async verifyTrashRemovalShadow(input: {
    targetIds: readonly string[];
    startHistoryId: string;
    primaryRestoredIds: ReadonlySet<string>;
  }): Promise<GmailUndoHistoryShadowResult> {
    const startedAt = performance.now();
    const targets = uniqueTargets(input.targetIds);
    if (!/^\d+$/.test(input.startHistoryId)) throw new Error("Invalid Gmail Undo history checkpoint.");
    const historyVerified = new Set<string>();
    let historyUnavailable = false;

    for (let poll = 0; poll < this.pollAttempts; poll += 1) {
      this.metrics.historyPollAttempts += 1;
      try {
        const history = await this.collectHistoryPages(input.startHistoryId);
        if (history.unavailable) {
          historyUnavailable = true;
          break;
        }
        collectTrashRemovalMatches(new Set(targets), history.pages).forEach((id) => historyVerified.add(id));
      } catch {
        historyUnavailable = true;
        break;
      }
      if (historyVerified.size === targets.length) break;
      if (poll < this.pollAttempts - 1) await this.sleepImpl(250 * 2 ** poll);
    }

    const fallbackTargets = targets.filter((id) => !historyVerified.has(id)).slice(0, maximumFallbackReads);
    const fallbackVerified = new Set<string>();
    for (const id of fallbackTargets) {
      try {
        const response = await this.request(
          `${gmailApiBaseUrl}/messages/${encodeURIComponent(id)}?format=metadata&fields=id,labelIds`,
          "getFallbackRequests"
        );
        const body = await readJson(response) as { id?: string; labelIds?: string[] };
        if (
          body.id === id &&
          Array.isArray(body.labelIds) &&
          !body.labelIds.some((label) => label.toUpperCase() === "TRASH")
        ) {
          fallbackVerified.add(id);
        }
      } catch {
        // Shadow fallback remains fail-closed; an unreadable target stays unresolved.
      }
    }

    const shadowVerified = new Set([...historyVerified, ...fallbackVerified]);
    let mismatchWithPrimaryCount = 0;
    for (const id of shadowVerified) {
      if (!input.primaryRestoredIds.has(id)) mismatchWithPrimaryCount += 1;
    }

    return {
      targetCount: targets.length,
      verifiedByHistory: historyVerified.size,
      verifiedByGetFallback: fallbackVerified.size,
      unresolvedCount: targets.length - shadowVerified.size,
      mismatchWithPrimaryCount,
      historyUnavailable,
      historyWallTimeMs: Math.round(performance.now() - startedAt),
      metrics: { ...this.metrics }
    };
  }

  private async collectHistoryPages(startHistoryId: string) {
    const pages: GmailUndoHistoryPage[] = [];
    let pageToken: string | undefined;
    const seenTokens = new Set<string>();
    do {
      if (pageToken) {
        if (seenTokens.has(pageToken)) throw new Error("Gmail Undo history pagination repeated a page token.");
        seenTokens.add(pageToken);
      }
      const params = new URLSearchParams({
        startHistoryId,
        historyTypes: "labelRemoved",
        maxResults: "500",
        fields: "history(labelsRemoved(message(id),labelIds)),nextPageToken,historyId"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.request(`${gmailApiBaseUrl}/history?${params.toString()}`, "historyListRequests", true);
      if (response.status === 404) return { pages: [], unavailable: true };
      pages.push(await readJson(response) as GmailUndoHistoryPage);
      this.metrics.historyPages += 1;
      pageToken = pages.at(-1)?.nextPageToken;
    } while (pageToken);
    return { pages, unavailable: false };
  }

  private async request(
    url: string,
    kind: "getProfileRequests" | "historyListRequests" | "getFallbackRequests",
    allow404 = false
  ) {
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < this.retryAttempts; attempt += 1) {
      if (attempt > 0) this.metrics.retryRequests += 1;
      this.metrics[kind] += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          signal: controller.signal
        });
        lastStatus = response.status;
        if (response.ok || (allow404 && response.status === 404)) return response;
        if (!isTransientStatus(response.status)) break;
      } catch (error) {
        if (attempt === this.retryAttempts - 1) {
          throw new Error(error instanceof DOMException && error.name === "AbortError"
            ? "Gmail Undo history verification timed out."
            : "Gmail Undo history verification transport failed.");
        }
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < this.retryAttempts - 1) await this.sleepImpl(200 * 2 ** attempt);
    }
    throw new Error(`Gmail Undo history verification failed with status ${lastStatus ?? "unavailable"}.`);
  }
}

type GmailUndoHistoryPage = {
  history?: Array<{
    labelsRemoved?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
    labelsAdded?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
  }>;
  nextPageToken?: string;
};

export function collectTrashRemovalMatches(targetIds: ReadonlySet<string>, pages: readonly GmailUndoHistoryPage[]) {
  const matches = new Set<string>();
  for (const page of pages) {
    for (const history of page.history ?? []) {
      for (const removal of history.labelsRemoved ?? []) {
        const id = removal.message?.id;
        if (id && targetIds.has(id) && removal.labelIds?.some((label) => label.toUpperCase() === "TRASH")) {
          matches.add(id);
        }
      }
    }
  }
  return matches;
}

function uniqueTargets(ids: readonly string[]) {
  if (ids.some((id) => !id)) throw new Error("Gmail Undo history target set contains an invalid ID.");
  if (new Set(ids).size !== ids.length) throw new Error("Gmail Undo history target set contains duplicate IDs.");
  return [...ids];
}

function isTransientStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function createMetrics(): GmailUndoHistoryShadowMetrics {
  return {
    getProfileRequests: 0,
    historyListRequests: 0,
    historyPages: 0,
    historyPollAttempts: 0,
    getFallbackRequests: 0,
    retryRequests: 0
  };
}

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new Error("Gmail Undo history verification returned an invalid response.");
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
