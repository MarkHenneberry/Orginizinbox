import "server-only";
import { ImapFlow } from "imapflow";
import { env } from "@/lib/config";
import {
  gmailScalePolicy,
  gmailScaleQuotaUnits
} from "@/lib/providers/gmail/scale-architecture";
import {
  assertMatchingUidValidity,
  evaluateExactImapRecheck
} from "@/lib/providers/gmail/scale-safety";
import { resolveGmailAllMail } from "@/lib/providers/gmail/provider";
import type { GmailScalableCleanupTarget } from "@/lib/providers/gmail/scalable-targets";

const gmailApiBaseUrl = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailScalableQuotaRequestKind = keyof typeof gmailScaleQuotaUnits;
export type GmailScalableQuotaReservation = (kind: GmailScalableQuotaRequestKind) => Promise<void>;

export class GmailScalableQuotaPauseError extends Error {
  constructor(readonly nextEligibleRunAt: number) {
    super("Gmail quota working budget is temporarily exhausted.");
    this.name = "GmailScalableQuotaPauseError";
  }
}

export type GmailScalableSafetyResult = {
  safeTargets: GmailScalableCleanupTarget[];
  missingCount: number;
  identityMismatchCount: number;
  starredCount: number;
  importantCount: number;
  trashCount: number;
  sentCount: number;
  draftCount: number;
  personalCount: number;
  personalListRequests: number;
  retryCount: number;
  imapMs: number;
  personalMs: number;
};

export type GmailScalableVerificationResult = {
  verifiedIds: string[];
  failedIds: string[];
  uncertainIds: string[];
  historyVerifiedCount: number;
  listVerifiedCount: number;
  getVerifiedCount: number;
  historyRequests: number;
  historyPages: number;
  historyPollAttempts: number;
  listRequests: number;
  listPages: number;
  getFallbackRequests: number;
  retryCount: number;
  historyUnavailable: boolean;
  durationMs: number;
};

export type GmailScalableTrashPostStateAuditResult = {
  exactTargetMessagesFoundInTrash: number;
  exactTargetMessagesAbsentFromTrash: number;
  distinctGmailThreadCount: number;
  trashListRequests: number;
  trashListPages: number;
};

export interface GmailScalableCleanupProviderPort {
  runSafetyCheck(input: {
    uidValidity: string;
    targets: readonly GmailScalableCleanupTarget[];
    reserve: GmailScalableQuotaReservation;
  }): Promise<GmailScalableSafetyResult>;
  captureHistoryCheckpoint(reserve: GmailScalableQuotaReservation): Promise<string>;
  moveToTrash(targetIds: readonly string[], reserve: GmailScalableQuotaReservation): Promise<void>;
  verifyTrash(input: {
    targetIds: readonly string[];
    startHistoryId: string;
    reserve: GmailScalableQuotaReservation;
  }): Promise<GmailScalableVerificationResult>;
  removeTrashLabel(targetIds: readonly string[], reserve: GmailScalableQuotaReservation): Promise<void>;
  verifyTrashRemoval(input: {
    targetIds: readonly string[];
    startHistoryId: string;
    reserve: GmailScalableQuotaReservation;
  }): Promise<GmailScalableVerificationResult>;
  auditTrashPostState(input: {
    targetIds: readonly string[];
    reserve: GmailScalableQuotaReservation;
  }): Promise<GmailScalableTrashPostStateAuditResult>;
}

export class GmailScalableCleanupProvider implements GmailScalableCleanupProviderPort {
  constructor(
    private readonly accessToken: string,
    private readonly accountEmail: string,
    private readonly options: {
      fetchImpl?: typeof fetch;
      sleepImpl?: (ms: number) => Promise<void>;
      pollAttempts?: number;
      retryAttempts?: number;
      requestTimeoutMs?: number;
    } = {}
  ) {
    if (!accessToken || !accountEmail) throw new Error("An active Gmail connection is required for scalable cleanup.");
  }

  async runSafetyCheck(input: {
    uidValidity: string;
    targets: readonly GmailScalableCleanupTarget[];
    reserve: GmailScalableQuotaReservation;
  }): Promise<GmailScalableSafetyResult> {
    const imapStarted = performance.now();
    const client = this.createImapClient();
    const messages = [];
    try {
      await client.connect();
      if (!client.capabilities.has("X-GM-EXT-1") || client.capabilities.has("OBJECTID")) {
        throw new Error("The explicit Gmail X-GM-MSGID bridge is unavailable.");
      }
      const mailbox = await client.mailboxOpen(await resolveGmailAllMail(client), { readOnly: true });
      if (!mailbox.readOnly) throw new Error("Gmail All Mail was not opened read-only.");
      assertMatchingUidValidity(BigInt(input.uidValidity), mailbox.uidValidity);
      const uids = input.targets.map((target) => target.uid);
      const exactFetchQuery = { uid: true, emailId: true, flags: true, labels: true } as Parameters<ImapFlow["fetch"]>[1];
      for await (const message of client.fetch(uids, exactFetchQuery, { uid: true })) {
        messages.push({ uid: message.uid, emailId: message.emailId, flags: message.flags, labels: [...(message.labels ?? [])] });
      }
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
    const imapMs = Math.round(performance.now() - imapStarted);
    const recheck = evaluateExactImapRecheck(input.targets, messages);
    const mutableEligible = new Set(recheck.eligibleIds);
    const personalStarted = performance.now();
    const personal = await this.collectMessageList({
      labelIds: "CATEGORY_PERSONAL",
      includeSpamTrash: "true",
      fields: "messages/id,nextPageToken"
    }, input.reserve);
    const personalMs = Math.round(performance.now() - personalStarted);
    const safeTargets = input.targets.filter(
      (target) => mutableEligible.has(target.apiMessageId) && !personal.ids.has(target.apiMessageId)
    );
    const states = [...recheck.statesById.values()];
    return {
      safeTargets,
      missingCount: recheck.excludedMissingCount,
      identityMismatchCount: recheck.excludedIdentityMismatchCount,
      starredCount: states.filter((state) => state.starred).length,
      importantCount: states.filter((state) => state.important).length,
      trashCount: states.filter((state) => state.trash).length,
      sentCount: states.filter((state) => state.sent).length,
      draftCount: states.filter((state) => state.draft).length,
      personalCount: input.targets.filter((target) => personal.ids.has(target.apiMessageId)).length,
      personalListRequests: personal.requests,
      retryCount: personal.retries,
      imapMs,
      personalMs
    };
  }

  async captureHistoryCheckpoint(reserve: GmailScalableQuotaReservation) {
    const metrics = createRequestMetrics();
    const response = await this.request(
      `${gmailApiBaseUrl}/profile?fields=historyId`,
      { method: "GET" },
      "getProfile",
      reserve,
      metrics,
      true
    );
    const body = await readJson(response) as { historyId?: string };
    if (!body.historyId || !/^\d+$/.test(body.historyId)) throw new Error("Gmail did not return a valid history checkpoint.");
    return body.historyId;
  }

  async moveToTrash(targetIds: readonly string[], reserve: GmailScalableQuotaReservation) {
    await this.batchModify(targetIds, { addLabelIds: ["TRASH"], removeLabelIds: [] }, reserve);
  }

  async removeTrashLabel(targetIds: readonly string[], reserve: GmailScalableQuotaReservation) {
    await this.batchModify(targetIds, { addLabelIds: [], removeLabelIds: ["TRASH"] }, reserve);
  }

  verifyTrash(input: {
    targetIds: readonly string[];
    startHistoryId: string;
    reserve: GmailScalableQuotaReservation;
  }) {
    return this.verifyLabelChange({ ...input, historyType: "labelAdded", historyField: "labelsAdded", expectedTrash: true });
  }

  verifyTrashRemoval(input: {
    targetIds: readonly string[];
    startHistoryId: string;
    reserve: GmailScalableQuotaReservation;
  }) {
    return this.verifyLabelChange({ ...input, historyType: "labelRemoved", historyField: "labelsRemoved", expectedTrash: false });
  }

  async auditTrashPostState(input: {
    targetIds: readonly string[];
    reserve: GmailScalableQuotaReservation;
  }): Promise<GmailScalableTrashPostStateAuditResult> {
    const targets = uniqueTargets(input.targetIds);
    const targetSet = new Set(targets);
    const foundTargetIds = new Set<string>();
    const threadByTargetId = new Map<string, string>();
    const seenTokens = new Set<string>();
    const metrics = createRequestMetrics();
    let pageToken: string | undefined;
    let pages = 0;
    do {
      if (pageToken && seenTokens.has(pageToken)) throw new Error("Gmail messages.list pagination repeated a page token.");
      if (pageToken) seenTokens.add(pageToken);
      const params = new URLSearchParams({
        labelIds: "TRASH",
        includeSpamTrash: "true",
        maxResults: "500",
        fields: "messages(id,threadId),nextPageToken"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.request(
        `${gmailApiBaseUrl}/messages?${params.toString()}`,
        { method: "GET" },
        "messagesList",
        input.reserve,
        metrics,
        true
      );
      pages += 1;
      if (response.status === 204) break;
      const body = await readJson(response) as {
        messages?: Array<{ id?: string; threadId?: string }>;
        nextPageToken?: string;
      };
      for (const message of body.messages ?? []) {
        if (!message.id || !targetSet.has(message.id)) continue;
        foundTargetIds.add(message.id);
        if (message.threadId && !threadByTargetId.has(message.id)) threadByTargetId.set(message.id, message.threadId);
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return {
      exactTargetMessagesFoundInTrash: foundTargetIds.size,
      exactTargetMessagesAbsentFromTrash: targets.length - foundTargetIds.size,
      distinctGmailThreadCount: new Set(threadByTargetId.values()).size,
      trashListRequests: pages + metrics.retries,
      trashListPages: pages
    };
  }

  private async batchModify(
    targetIds: readonly string[],
    labels: { addLabelIds: string[]; removeLabelIds: string[] },
    reserve: GmailScalableQuotaReservation
  ) {
    const ids = uniqueTargets(targetIds);
    if (ids.length > 1_000) throw new Error("Gmail batchModify accepts at most 1000 messages.");
    const metrics = createRequestMetrics();
    await this.request(
      `${gmailApiBaseUrl}/messages/batchModify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, ...labels })
      },
      "batchModify",
      reserve,
      metrics,
      false
    );
  }

  private async verifyLabelChange(input: {
    targetIds: readonly string[];
    startHistoryId: string;
    reserve: GmailScalableQuotaReservation;
    historyType: "labelAdded" | "labelRemoved";
    historyField: "labelsAdded" | "labelsRemoved";
    expectedTrash: boolean;
  }): Promise<GmailScalableVerificationResult> {
    const startedAt = performance.now();
    const targets = uniqueTargets(input.targetIds);
    const targetSet = new Set(targets);
    const historyVerified = new Set<string>();
    const metrics = createVerificationMetrics();
    let historyUnavailable = false;
    const pollAttempts = clamp(this.options.pollAttempts ?? 3, 1, 5);

    for (let poll = 0; poll < pollAttempts; poll += 1) {
      metrics.historyPollAttempts += 1;
      const history = await this.collectHistory(input.startHistoryId, input.historyType, input.historyField, input.reserve, metrics);
      if (history.unavailable) {
        historyUnavailable = true;
        break;
      }
      for (const id of collectHistoryMatches(targetSet, history.pages, input.historyField)) historyVerified.add(id);
      if (historyVerified.size === targets.length) break;
      if (poll < pollAttempts - 1) await (this.options.sleepImpl ?? sleep)(250 * 2 ** poll);
    }

    const unresolvedAfterHistory = targets.filter((id) => !historyVerified.has(id));
    const trashList = unresolvedAfterHistory.length
      ? await this.collectMessageList({
          labelIds: "TRASH",
          includeSpamTrash: "true",
          fields: "messages/id,nextPageToken"
        }, input.reserve, metrics)
      : { ids: new Set<string>(), requests: 0, pages: 0, retries: 0 };
    const listVerified = new Set<string>();
    const failed = new Set<string>();
    const unresolvedAfterList: string[] = [];
    for (const id of unresolvedAfterHistory) {
      const listedInTrash = trashList.ids.has(id);
      if (input.expectedTrash && listedInTrash) listVerified.add(id);
      else if (!input.expectedTrash && listedInTrash) failed.add(id);
      else unresolvedAfterList.push(id);
    }

    const fallbackIds = unresolvedAfterList.slice(0, gmailScalePolicy.maxGetFallbackPerChunk);
    const heldUncertain = unresolvedAfterList.slice(gmailScalePolicy.maxGetFallbackPerChunk);
    const getVerified = new Set<string>();
    const uncertain = new Set<string>(heldUncertain);
    for (const id of fallbackIds) {
      metrics.getFallbackRequests += 1;
      try {
        const response = await this.request(
          `${gmailApiBaseUrl}/messages/${encodeURIComponent(id)}?format=metadata&fields=id,labelIds`,
          { method: "GET" },
          "messagesGet",
          input.reserve,
          metrics,
          true
        );
        const body = await readJson(response) as { id?: string; labelIds?: string[] };
        const inTrash = body.id === id && body.labelIds?.some((label) => label.toUpperCase() === "TRASH") === true;
        if (body.id !== id || !Array.isArray(body.labelIds)) uncertain.add(id);
        else if (inTrash === input.expectedTrash) getVerified.add(id);
        else failed.add(id);
      } catch (error) {
        if (error instanceof GmailScalableQuotaPauseError) throw error;
        uncertain.add(id);
      }
    }

    const verifiedIds = [...historyVerified, ...listVerified, ...getVerified];
    return {
      verifiedIds,
      failedIds: targets.filter((id) => failed.has(id)),
      uncertainIds: targets.filter((id) => uncertain.has(id)),
      historyVerifiedCount: historyVerified.size,
      listVerifiedCount: listVerified.size,
      getVerifiedCount: getVerified.size,
      historyRequests: metrics.historyRequests,
      historyPages: metrics.historyPages,
      historyPollAttempts: metrics.historyPollAttempts,
      listRequests: trashList.requests,
      listPages: trashList.pages,
      getFallbackRequests: metrics.getFallbackRequests,
      retryCount: metrics.retries,
      historyUnavailable,
      durationMs: Math.round(performance.now() - startedAt)
    };
  }

  private async collectHistory(
    startHistoryId: string,
    historyType: "labelAdded" | "labelRemoved",
    historyField: "labelsAdded" | "labelsRemoved",
    reserve: GmailScalableQuotaReservation,
    metrics: VerificationMetrics
  ) {
    const pages: HistoryPage[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      if (pageToken && seenTokens.has(pageToken)) throw new Error("Gmail history pagination repeated a page token.");
      if (pageToken) seenTokens.add(pageToken);
      const params = new URLSearchParams({
        startHistoryId,
        historyTypes: historyType,
        maxResults: "500",
        fields: `history(${historyField}(message(id),labelIds)),nextPageToken,historyId`
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.request(
        `${gmailApiBaseUrl}/history?${params.toString()}`,
        { method: "GET" },
        "historyList",
        reserve,
        metrics,
        true,
        true
      );
      metrics.historyRequests += 1;
      if (response.status === 404) return { pages: [], unavailable: true };
      const page = await readJson(response) as HistoryPage;
      pages.push(page);
      metrics.historyPages += 1;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { pages, unavailable: false };
  }

  private async collectMessageList(
    paramsInput: Record<string, string>,
    reserve: GmailScalableQuotaReservation,
    externalMetrics?: VerificationMetrics
  ) {
    const ids = new Set<string>();
    const seenTokens = new Set<string>();
    const metrics = externalMetrics ?? createVerificationMetrics();
    let pageToken: string | undefined;
    let requests = 0;
    let pages = 0;
    const retriesBefore = metrics.retries;
    do {
      if (pageToken && seenTokens.has(pageToken)) throw new Error("Gmail messages.list pagination repeated a page token.");
      if (pageToken) seenTokens.add(pageToken);
      const params = new URLSearchParams({ ...paramsInput, maxResults: "500" });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.request(
        `${gmailApiBaseUrl}/messages?${params.toString()}`,
        { method: "GET" },
        "messagesList",
        reserve,
        metrics,
        true
      );
      requests += 1;
      pages += 1;
      if (response.status === 204) break;
      const body = await readJson(response) as { messages?: Array<{ id?: string }>; nextPageToken?: string };
      for (const message of body.messages ?? []) if (message.id) ids.add(message.id);
      pageToken = body.nextPageToken;
    } while (pageToken);
    return { ids, requests, pages, retries: metrics.retries - retriesBefore };
  }

  private async request(
    url: string,
    init: RequestInit,
    quotaKind: GmailScalableQuotaRequestKind,
    reserve: GmailScalableQuotaReservation,
    metrics: RequestMetrics,
    retrySafe: boolean,
    allow404 = false
  ) {
    const attempts = retrySafe ? clamp(this.options.retryAttempts ?? 3, 1, 4) : 1;
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await reserve(quotaKind);
      if (attempt > 0) metrics.retries += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), clamp(this.options.requestTimeoutMs ?? 10_000, 1, 30_000));
      try {
        const response = await (this.options.fetchImpl ?? fetch)(url, {
          ...init,
          headers: { Authorization: `Bearer ${this.accessToken}`, ...(init.headers ?? {}) },
          signal: controller.signal
        });
        lastStatus = response.status;
        if (response.ok || (allow404 && response.status === 404)) return response;
        if (!isTransientStatus(response.status) || !retrySafe) break;
      } catch (error) {
        if (attempt === attempts - 1) {
          throw new Error(error instanceof DOMException && error.name === "AbortError"
            ? "Gmail scalable cleanup request timed out."
            : "Gmail scalable cleanup request failed.");
        }
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < attempts - 1) await (this.options.sleepImpl ?? sleep)(200 * 2 ** attempt);
    }
    throw new Error(`Gmail scalable cleanup request failed with status ${lastStatus ?? "unavailable"}.`);
  }

  private createImapClient() {
    return new ImapFlow({
      host: env.GMAIL_IMAP_HOST,
      port: env.GMAIL_IMAP_PORT,
      secure: true,
      logger: false,
      disableAutoIdle: true,
      auth: { user: this.accountEmail, accessToken: this.accessToken },
      tls: { rejectUnauthorized: true }
    });
  }
}

type HistoryPage = {
  history?: Array<{
    labelsAdded?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
    labelsRemoved?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
  }>;
  nextPageToken?: string;
};

type RequestMetrics = { retries: number };
type VerificationMetrics = RequestMetrics & {
  historyRequests: number;
  historyPages: number;
  historyPollAttempts: number;
  getFallbackRequests: number;
};

function createRequestMetrics(): RequestMetrics {
  return { retries: 0 };
}

function createVerificationMetrics(): VerificationMetrics {
  return { retries: 0, historyRequests: 0, historyPages: 0, historyPollAttempts: 0, getFallbackRequests: 0 };
}

function collectHistoryMatches(targets: ReadonlySet<string>, pages: readonly HistoryPage[], field: "labelsAdded" | "labelsRemoved") {
  const matches = new Set<string>();
  for (const page of pages) {
    for (const record of page.history ?? []) {
      for (const change of record[field] ?? []) {
        const id = change.message?.id;
        if (id && targets.has(id) && change.labelIds?.some((label) => label.toUpperCase() === "TRASH")) matches.add(id);
      }
    }
  }
  return matches;
}

function uniqueTargets(ids: readonly string[]) {
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Invalid scalable Gmail target set.");
  return [...ids];
}

function isTransientStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new Error("Gmail scalable cleanup returned an invalid response.");
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
