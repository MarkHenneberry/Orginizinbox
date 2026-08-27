import "server-only";
import { reconcileTrashHistory, type GmailHistoryPage } from "@/lib/providers/gmail/scale-architecture";

const gmailApiBaseUrl = "https://gmail.googleapis.com/gmail/v1/users/me";
export const gmailShadowProofTargetCount = 25;

export type GmailShadowVerifierMetrics = {
  getProfileRequests: number;
  historyListRequests: number;
  historyPages: number;
  historyPollAttempts: number;
  trashListRequests: number;
  trashListPages: number;
  getFallbackRequests: number;
  retryRequests: number;
};

export type GmailShadowVerificationResult = {
  targetCount: number;
  verifiedByHistory: number;
  verifiedByTrashList: number;
  verifiedByGetFallback: number;
  getFallbackRequired: number;
  unresolvedCount: number;
  mismatchWithPrimaryCount: number;
  historyUnavailable: boolean;
  metrics: GmailShadowVerifierMetrics;
};

export type GmailShadowVerifierOptions = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  retryAttempts?: number;
  requestTimeoutMs?: number;
};

export class GmailShadowVerifier {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly pollAttempts: number;
  private readonly retryAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly metrics = createMetrics();

  constructor(
    private readonly accessToken: string,
    options: GmailShadowVerifierOptions = {}
  ) {
    if (!accessToken) throw new Error("Missing Gmail access token for shadow verification.");
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
      throw new Error("Gmail profile did not provide a valid history checkpoint.");
    }
    return body.historyId;
  }

  async verifyTrashShadow(input: {
    targetIds: readonly string[];
    startHistoryId: string;
    primaryVerifiedIds?: ReadonlySet<string>;
  }): Promise<GmailShadowVerificationResult> {
    const targets = uniqueTargets(input.targetIds);
    if (!/^\d+$/.test(input.startHistoryId)) throw new Error("Invalid Gmail shadow history checkpoint.");
    const historyVerified = new Set<string>();
    let historyUnavailable = false;

    for (let poll = 0; poll < this.pollAttempts; poll += 1) {
      this.metrics.historyPollAttempts += 1;
      const history = await this.collectHistoryPages(input.startHistoryId);
      if (history.unavailable) {
        historyUnavailable = true;
        break;
      }
      reconcileTrashHistory(targets, history.pages).verifiedIds.forEach((id) => historyVerified.add(id));
      if (historyVerified.size === targets.length) break;
      if (poll < this.pollAttempts - 1) await this.sleepImpl(250 * 2 ** poll);
    }

    const unresolvedAfterHistory = targets.filter((id) => !historyVerified.has(id));
    const trashListVerified = await this.reconcileTrashList(unresolvedAfterHistory);
    const unresolvedAfterList = unresolvedAfterHistory.filter((id) => !trashListVerified.has(id));
    const fallbackIds = unresolvedAfterList.slice(0, 10);
    const getVerified = new Set<string>();
    for (const id of fallbackIds) {
      try {
        const response = await this.request(
          `${gmailApiBaseUrl}/messages/${encodeURIComponent(id)}?format=metadata&fields=id,labelIds`,
          "getFallbackRequests"
        );
        const body = await readJson(response) as { id?: string; labelIds?: string[] };
        if (body.id === id && body.labelIds?.some((label) => label.toUpperCase() === "TRASH")) getVerified.add(id);
      } catch {
        // Shadow verification remains fail-closed: a failed exception read stays unresolved.
      }
    }

    const shadowVerified = new Set([...historyVerified, ...trashListVerified, ...getVerified]);
    const primaryVerified = input.primaryVerifiedIds;
    const mismatchWithPrimaryCount = primaryVerified
      ? symmetricDifferenceCount(primaryVerified, shadowVerified, new Set(targets))
      : 0;

    return {
      targetCount: targets.length,
      verifiedByHistory: historyVerified.size,
      verifiedByTrashList: trashListVerified.size,
      verifiedByGetFallback: getVerified.size,
      getFallbackRequired: unresolvedAfterList.length,
      unresolvedCount: targets.length - shadowVerified.size,
      mismatchWithPrimaryCount,
      historyUnavailable,
      metrics: { ...this.metrics }
    };
  }

  private async collectHistoryPages(startHistoryId: string): Promise<{ pages: GmailHistoryPage[]; unavailable: boolean }> {
    const pages: GmailHistoryPage[] = [];
    let pageToken: string | undefined;
    const seenTokens = new Set<string>();
    do {
      if (pageToken) {
        if (seenTokens.has(pageToken)) throw new Error("Gmail history pagination repeated a page token.");
        seenTokens.add(pageToken);
      }
      const params = new URLSearchParams({
        startHistoryId,
        historyTypes: "labelAdded",
        maxResults: "500",
        fields: "history(labelsAdded(message(id),labelIds)),nextPageToken,historyId"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.request(`${gmailApiBaseUrl}/history?${params.toString()}`, "historyListRequests", true);
      if (response.status === 404) return { pages: [], unavailable: true };
      const body = await readJson(response) as GmailHistoryPage;
      pages.push(body);
      this.metrics.historyPages += 1;
      pageToken = body.nextPageToken;
    } while (pageToken);
    return { pages, unavailable: false };
  }

  private async reconcileTrashList(targetIds: readonly string[]) {
    const targets = new Set(targetIds);
    const verified = new Set<string>();
    if (targets.size === 0) return verified;
    let pageToken: string | undefined;
    const seenTokens = new Set<string>();
    do {
      if (pageToken) {
        if (seenTokens.has(pageToken)) throw new Error("Gmail Trash pagination repeated a page token.");
        seenTokens.add(pageToken);
      }
      const params = new URLSearchParams({
        labelIds: "TRASH",
        includeSpamTrash: "true",
        maxResults: "500",
        fields: "messages/id,nextPageToken"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.request(`${gmailApiBaseUrl}/messages?${params.toString()}`, "trashListRequests");
      if (response.status === 204) break;
      const body = await readJson(response) as { messages?: Array<{ id?: string }>; nextPageToken?: string };
      for (const message of body.messages ?? []) {
        if (message.id && targets.has(message.id)) verified.add(message.id);
      }
      this.metrics.trashListPages += 1;
      pageToken = body.nextPageToken;
    } while (pageToken);
    return verified;
  }

  private async request(
    url: string,
    kind: "getProfileRequests" | "historyListRequests" | "trashListRequests" | "getFallbackRequests",
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
            ? "Gmail shadow verification timed out."
            : "Gmail shadow verification transport failed.");
        }
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < this.retryAttempts - 1) await this.sleepImpl(200 * 2 ** attempt);
    }
    throw new Error(`Gmail shadow verification failed with status ${lastStatus ?? "unavailable"}.`);
  }
}

export function assertGmailShadowProofInput(input: {
  enabled: boolean;
  nodeEnv: string | undefined;
  targetIds: readonly string[];
}) {
  if (input.nodeEnv === "production" || !input.enabled) throw new Error("Gmail shadow proof is disabled.");
  const targets = uniqueTargets(input.targetIds);
  if (targets.length !== gmailShadowProofTargetCount) {
    throw new Error(`Gmail shadow proof requires exactly ${gmailShadowProofTargetCount} messages.`);
  }
  return targets;
}

function uniqueTargets(ids: readonly string[]) {
  if (ids.some((id) => !id)) throw new Error("Gmail shadow target set contains an invalid ID.");
  if (new Set(ids).size !== ids.length) throw new Error("Gmail shadow target set contains duplicate IDs.");
  return [...ids];
}

function symmetricDifferenceCount(left: ReadonlySet<string>, right: ReadonlySet<string>, targets: ReadonlySet<string>) {
  let count = 0;
  for (const id of targets) if (left.has(id) !== right.has(id)) count += 1;
  return count;
}

function isTransientStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function createMetrics(): GmailShadowVerifierMetrics {
  return {
    getProfileRequests: 0,
    historyListRequests: 0,
    historyPages: 0,
    historyPollAttempts: 0,
    trashListRequests: 0,
    trashListPages: 0,
    getFallbackRequests: 0,
    retryRequests: 0
  };
}

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new Error("Gmail shadow verification returned an invalid response.");
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
