import { describe, expect, it, vi } from "vitest";
import { assessMessage } from "@/lib/domain/recommendations";
import {
  MicrosoftGraphClient,
  MicrosoftGraphMutationUncertainError,
  MicrosoftGraphPaginationError
} from "@/lib/providers/microsoft/graph-client";
import {
  MicrosoftProvider,
  microsoftExperimentalFolderPageSize,
  microsoftMainMessageFallbackPageSize,
  microsoftMainMessagePreferredPageSize,
  normalizeMicrosoftMessage,
  type MicrosoftFolderIndex
} from "@/lib/providers/microsoft/provider";

describe("Microsoft Graph read-only client", () => {
  it("refreshes once after a 401 and retries only with GET", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ value: [] }));
    const refreshAccessToken = vi.fn().mockResolvedValue("refreshed-token");
    const client = new MicrosoftGraphClient({
      accessToken: "expired-token",
      fetchImpl: fetchImpl as typeof fetch,
      refreshAccessToken
    });

    await expect(client.getJson("/me/messages")).resolves.toEqual({ value: [] });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.getMetrics().failures401).toBe(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer refreshed-token" })
    });
  });

  it("rejects untrusted pagination origins before sending credentials", async () => {
    const fetchImpl = vi.fn();
    const client = new MicrosoftGraphClient({ accessToken: "token", fetchImpl: fetchImpl as typeof fetch });
    await expect(client.getJson("https://example.test/v1.0/me/messages")).rejects.toBeInstanceOf(
      MicrosoftGraphPaginationError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honors bounded throttling and transient-server retries", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ value: [] }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new MicrosoftGraphClient({
      accessToken: "token",
      fetchImpl: fetchImpl as typeof fetch,
      sleep,
      maxRetries: 2
    });

    await expect(client.getJson("/me/messages")).resolves.toEqual({ value: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 0, undefined);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(client.getMetrics()).toMatchObject({
      requests: 3,
      retries: 2,
      throttles429: 1,
      failures5xx: 1
    });
  });

  it("counts a forbidden response without exposing its body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("private provider response", { status: 403 }));
    const client = new MicrosoftGraphClient({ accessToken: "token", fetchImpl: fetchImpl as typeof fetch });
    await expect(client.getJson("/me/messages")).rejects.toThrow(/mail access was not granted/i);
    expect(client.getMetrics().failures403).toBe(1);
  });

  it("classifies an otherwise-untracked 4xx without retries or provider content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "PrivateProviderCode",
        message: "private mailbox response",
        messageId: "sensitive-message-id"
      }
    }), { status: 400 }));
    const sleep = vi.fn();
    const client = new MicrosoftGraphClient({
      accessToken: "token",
      fetchImpl: fetchImpl as typeof fetch,
      sleep
    });

    let errorMessage = "";
    try {
      await client.getJson("/me/mailFolders", undefined, "main_message_scan");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toBe(
      "Outlook scan request was rejected by Microsoft Graph (HTTP 400, bad_request)."
    );
    expect(errorMessage).not.toMatch(/PrivateProviderCode|private mailbox response|sensitive-message-id/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(client.getMetrics()).toMatchObject({
      requests: 1,
      retries: 0,
      other4xxFailures: 1,
      lastOther4xxStatus: 400,
      lastOther4xxCategory: "bad_request",
      lastOther4xxOperation: "main_message_scan"
    });
  });

  it("classifies a successful HTTP response with invalid JSON without exposing content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("private malformed content", {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const client = new MicrosoftGraphClient({
      accessToken: "token",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(
      client.getJson("/me/messages", undefined, "main_message_scan")
    ).rejects.toThrow("Outlook returned an unexpected response");
    expect(client.getMetrics()).toMatchObject({
      lastNonHttpFailureOperation: "main_message_scan",
      lastNonHttpFailureCategory: "invalid_json"
    });
    expect(JSON.stringify(client.getMetrics())).not.toContain("private malformed content");
  });

  it("classifies an exhausted fetch failure as network without request details", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("private network details"));
    const client = new MicrosoftGraphClient({
      accessToken: "token",
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0
    });

    await expect(
      client.getJson("/me/messages", undefined, "main_message_scan")
    ).rejects.toThrow("Outlook is temporarily unavailable");
    expect(client.getMetrics()).toMatchObject({
      lastNonHttpFailureOperation: "main_message_scan",
      lastNonHttpFailureCategory: "network"
    });
    expect(JSON.stringify(client.getMetrics())).not.toContain("private network details");
  });

  it("correlates reordered JSON batch responses and distinguishes round trips from subrequests", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { requests: Array<{ id: string; dependsOn?: string[] }> };
      expect(payload.requests).toHaveLength(3);
      expect(payload.requests.every((request) => request.dependsOn === undefined)).toBe(true);
      return jsonResponse({
        responses: [
          { id: "2", status: 201, headers: {}, body: { id: "moved-3" } },
          { id: "0", status: 201, headers: {}, body: { id: "moved-1" } },
          { id: "1", status: 201, headers: {}, body: { id: "moved-2" } }
        ]
      });
    });
    const client = new MicrosoftGraphClient({ accessToken: "token", fetchImpl: fetchImpl as typeof fetch });

    const responses = await client.batchJson([
      { id: "0", method: "POST", url: "/me/messages/one/move", headers: { "Content-Type": "application/json" }, body: { destinationId: "deleted" } },
      { id: "1", method: "POST", url: "/me/messages/two/move", headers: { "Content-Type": "application/json" }, body: { destinationId: "deleted" } },
      { id: "2", method: "POST", url: "/me/messages/three/move", headers: { "Content-Type": "application/json" }, body: { destinationId: "deleted" } }
    ], "cleanup_move", { mutation: true });

    expect(responses.map((response) => response.id)).toEqual(["0", "1", "2"]);
    expect(client.getMetrics()).toMatchObject({ requests: 1, subrequests: 3, retries: 0 });
  });

  it("never retries a mutation batch after an ambiguous transport failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("private network details"));
    const sleep = vi.fn();
    const client = new MicrosoftGraphClient({
      accessToken: "token",
      fetchImpl: fetchImpl as typeof fetch,
      sleep,
      maxRetries: 3
    });

    await expect(client.batchJson([
      { id: "0", method: "POST", url: "/me/messages/one/move", headers: { "Content-Type": "application/json" }, body: { destinationId: "deleted" } }
    ], "cleanup_move", { mutation: true })).rejects.toBeInstanceOf(MicrosoftGraphMutationUncertainError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(client.getMetrics()).toMatchObject({ requests: 1, subrequests: 1, retries: 0 });
  });
});

describe("Microsoft Graph metadata scan", () => {
  it("scans one sequential mailbox-wide full-evidence chain and preserves folder safety", async () => {
    const requestedUrls: URL[] = [];
    const mailboxMessages = [
      message("inbox-list-1", "inbox-id", "bulk-conversation"),
      message("participated", "inbox-id", "participated-conversation"),
      message("unknown-location", "missing-folder", "other-conversation"),
      message("sent-message", "sent-id", "sent-conversation"),
      message("draft-message", "draft-id", "draft-conversation", { isDraft: true }),
      message("deleted-root-message", "deleted-id", "deleted-root-conversation"),
      message("deleted-message", "deleted-child-id", "deleted-conversation")
    ];
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      try {
        if (url.pathname === "/v1.0/me/mailFolders/inbox") return jsonResponse(folder("inbox-id", { totalItemCount: 3 }));
        if (url.pathname === "/v1.0/me/mailFolders/sentitems") return jsonResponse(folder("sent-id", { totalItemCount: 2 }));
        if (url.pathname === "/v1.0/me/mailFolders/drafts") return jsonResponse(folder("draft-id", { totalItemCount: 1 }));
        if (url.pathname === "/v1.0/me/mailFolders/deleteditems") return jsonResponse(folder("deleted-id", { childFolderCount: 1, totalItemCount: 1 }));
        if (url.pathname === "/v1.0/me/mailFolders") return jsonResponse({ value: [
          folder("inbox-id", { totalItemCount: 3 }),
          folder("sent-id", { totalItemCount: 2 }),
          folder("draft-id", { totalItemCount: 1 }),
          folder("deleted-id", { childFolderCount: 1, totalItemCount: 1 })
        ] });
        if (url.pathname.endsWith("/deleted-id/childFolders")) return jsonResponse({ value: [folder("deleted-child-id", { totalItemCount: 1 })] });
        if (url.pathname.endsWith("/sent-id/messages") && url.searchParams.get("$select") === "conversationId") {
          return jsonResponse({ value: [
            { conversationId: "participated-conversation" },
            { conversationId: "second-participated-conversation" }
          ] });
        }
        if (url.pathname === "/v1.0/me/messages" && url.searchParams.get("$skiptoken") === "page-2") {
          return jsonResponse({ value: mailboxMessages.slice(4) });
        }
        if (url.pathname === "/v1.0/me/messages") {
          return jsonResponse({
            value: mailboxMessages.slice(0, 4),
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page-2"
          });
        }
        throw new Error(`Unexpected Graph request phase: ${url.pathname}`);
      } finally {
        active -= 1;
      }
    });
    const provider = new MicrosoftProvider("token", { fetchImpl: fetchImpl as typeof fetch });

    const participated = await provider.scanParticipatedConversationIds({ batchSize: 250 });
    const records = [];
    for await (const batch of provider.scanMetadata({ batchSize: 250, limit: "full" })) {
      records.push(...batch.records);
    }

    expect(participated).toEqual(new Set(["participated-conversation", "second-participated-conversation"]));
    expect(records).toHaveLength(7);
    expect(provider.getScanMetrics()).toMatchObject({
      foldersScanned: 1,
      headerEnrichmentRequests: 0,
      messagesEnriched: 0,
      mainMessagePageSize: 100,
      mainMessagePageSizes: [100],
      mainMessagePageFallbacks: 0,
      maxConcurrentRequests: 1
    });
    expect(maxActive).toBe(1);

    expect(requestedUrls[0].pathname).toBe("/v1.0/me/mailFolders/inbox");
    expect(requestedUrls.slice(0, 4).map((url) => url.pathname)).toEqual([
      "/v1.0/me/mailFolders/inbox",
      "/v1.0/me/mailFolders/sentitems",
      "/v1.0/me/mailFolders/drafts",
      "/v1.0/me/mailFolders/deleteditems"
    ]);
    const folderRequests = requestedUrls.filter((url) => url.pathname.includes("/mailFolders"));
    expect(folderRequests.every((url) => !url.searchParams.get("$select")?.includes("wellKnownName"))).toBe(true);
    const rootFolderRequest = requestedUrls.find((url) => url.pathname === "/v1.0/me/mailFolders");
    expect(rootFolderRequest?.searchParams.get("includeHiddenFolders")).toBe("true");
    expect(rootFolderRequest?.searchParams.get("$top")).toBe("100");

    const messageRequests = requestedUrls.filter((url) => url.pathname === "/v1.0/me/messages");
    const messageRequest = messageRequests.find((url) => url.searchParams.get("$select")?.includes("parentFolderId"));
    expect(messageRequest?.searchParams.get("$select")?.split(",")).toEqual(expect.arrayContaining([
      "id",
      "parentFolderId",
      "internetMessageHeaders"
    ]));
    expect(messageRequest?.searchParams.get("$top")).toBe("100");
    expect(messageRequests).toHaveLength(2);
    expect(messageRequests[1]?.searchParams.get("$skiptoken")).toBe("page-2");
    expect(microsoftMainMessagePreferredPageSize).toBe(100);
    expect(microsoftMainMessageFallbackPageSize).toBe(50);
    expect(microsoftExperimentalFolderPageSize).toBe(200);
    const requestedFields = messageRequest?.searchParams.get("$select") ?? "";
    expect(requestedFields).not.toMatch(/body|bodyPreview|attachments|hasAttachments/i);
    expect(requestedFields).not.toContain("size");
    expect(requestedFields).toContain("flag");
    expect(requestedFields).toContain("internetMessageHeaders");

    const byId = new Map(records.map((record) => [record.providerMessageId, record]));
    expect(byId.get("inbox-list-1")).toMatchObject({
      provider: "microsoft",
      listId: "newsletter.example.test",
      hasListUnsubscribe: true,
      precedence: "bulk",
      isSent: false,
      isDraft: false,
      isExcludedMailboxLocation: false
    });
    expect(assessMessage(byId.get("participated")!, { now: new Date("2026-08-31T00:00:00Z"), participatedConversationIds: participated }).protectionReasons)
      .toContain("PROTECTED_USER_PARTICIPATED_CONVERSATION");
    expect(assessMessage(byId.get("sent-message")!, { now: new Date("2026-08-31T00:00:00Z") }).protectionReasons)
      .toContain("PROTECTED_SENT");
    expect(assessMessage(byId.get("draft-message")!, { now: new Date("2026-08-31T00:00:00Z") }).protectionReasons)
      .toContain("PROTECTED_DRAFT");
    for (const deletedId of ["deleted-root-message", "deleted-message"]) {
      const assessment = assessMessage(byId.get(deletedId)!, {
        now: new Date("2026-08-31T00:00:00Z")
      });
      expect(assessment.protectionReasons).toContain("PROTECTED_MAILBOX_LOCATION");
      expect(assessment.eligibleForCleanup).toBe(false);
    }
    expect(assessMessage(byId.get("unknown-location")!, { now: new Date("2026-08-31T00:00:00Z") }).protectionReasons)
      .toContain("PROTECTED_MAILBOX_LOCATION");
    expect(records.every((record) => record.estimatedSize === undefined)).toBe(true);
  });

  it("restarts the complete mailbox-wide scan at 50 after an invalid page", async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);
      if (url.pathname === "/v1.0/me/mailFolders/inbox") return jsonResponse(folder("inbox-id", { totalItemCount: 1 }));
      if (url.pathname === "/v1.0/me/mailFolders/sentitems") return jsonResponse(folder("sent-id", { totalItemCount: 0 }));
      if (url.pathname === "/v1.0/me/mailFolders/drafts") return jsonResponse(folder("draft-id", { totalItemCount: 0 }));
      if (url.pathname === "/v1.0/me/mailFolders/deleteditems") return jsonResponse(folder("deleted-id", { totalItemCount: 0 }));
      if (url.pathname === "/v1.0/me/mailFolders") return jsonResponse({ value: [
        folder("inbox-id", { totalItemCount: 1 }),
        folder("sent-id", { totalItemCount: 0 }),
        folder("draft-id", { totalItemCount: 0 }),
        folder("deleted-id", { totalItemCount: 0 })
      ] });
      if (url.pathname.endsWith("/sent-id/messages")) return jsonResponse({ value: [] });
      if (url.pathname === "/v1.0/me/messages" && url.searchParams.get("$top") === "100") return jsonResponse({
        value: [message("discarded-attempt", "inbox-id", "attempt-conversation")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=invalid"
      });
      if (url.searchParams.get("$skiptoken") === "invalid") return new Response("invalid-json", { status: 200 });
      if (url.pathname === "/v1.0/me/messages" && url.searchParams.get("$top") === "50") return jsonResponse({ value: [] });
      throw new Error(`Unexpected Graph request: ${url.pathname}${url.search}`);
    });
    const provider = new MicrosoftProvider("token", { fetchImpl: fetchImpl as typeof fetch });
    const acceptedIds: string[] = [];
    let fallbackCount = 0;

    await provider.scanParticipatedConversationIds({ batchSize: 250 });
    await provider.processMetadataWithAdaptiveFallback({
      scan: { batchSize: 250, limit: "full" },
      onBatch(batch) {
        acceptedIds.push(...batch.records.map((record) => record.providerMessageId));
      },
      onFallback() {
        fallbackCount += 1;
        acceptedIds.length = 0;
      }
    });

    const mainStarts = requestedUrls.filter(
      (url) => url.pathname === "/v1.0/me/messages" && url.searchParams.has("$select")
    );
    expect(mainStarts.map((url) => url.searchParams.get("$top"))).toEqual(["100", "50"]);
    expect(acceptedIds).toEqual([]);
    expect(fallbackCount).toBe(1);
    expect(provider.getScanMetrics()).toMatchObject({
      mainMessagePageSize: 50,
      mainMessagePages: 1,
      mainMessagePageFallbacks: 1,
      lastNonHttpFailureOperation: "main_message_scan",
      lastNonHttpFailureCategory: "invalid_json"
    });
  });

  it("restarts the mailbox-wide scan at 50 after HTTP 413", async () => {
    const requestedUrls: URL[] = [];
    const responses = [
      jsonResponse(folder("inbox-id", { totalItemCount: 1 })),
      jsonResponse(folder("sent-id", { totalItemCount: 0 })),
      jsonResponse(folder("draft-id", { totalItemCount: 0 })),
      jsonResponse(folder("deleted-id", { totalItemCount: 0 })),
      jsonResponse({ value: [
        folder("inbox-id", { totalItemCount: 1 }),
        folder("sent-id", { totalItemCount: 0 }),
        folder("draft-id", { totalItemCount: 0 }),
        folder("deleted-id", { totalItemCount: 0 })
      ] }),
      jsonResponse({ value: [] }),
      new Response(null, { status: 413 }),
      jsonResponse({ value: [] })
    ];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrls.push(new URL(input instanceof Request ? input.url : input.toString()));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected Graph request");
      return response;
    });
    const provider = new MicrosoftProvider("token", { fetchImpl: fetchImpl as typeof fetch });
    let fallbackCount = 0;

    await provider.scanParticipatedConversationIds({ batchSize: 250 });
    await provider.processMetadataWithAdaptiveFallback({
      scan: { batchSize: 250, limit: "full" },
      onBatch() {},
      onFallback() {
        fallbackCount += 1;
      }
    });

    const mainStarts = requestedUrls.filter(
      (url) => url.pathname === "/v1.0/me/messages" && url.searchParams.has("$select")
    );
    expect(mainStarts.map((url) => url.searchParams.get("$top"))).toEqual(["100", "50"]);
    expect(fallbackCount).toBe(1);
    expect(provider.getScanMetrics()).toMatchObject({
      mainMessagePageSize: 50,
      mainMessagePageFallbacks: 1,
      other4xxFailures: 1,
      lastOther4xxStatus: 413
    });
  });

  it("does not change the adaptive page size after an exhausted 504", async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);
      if (url.pathname === "/v1.0/me/mailFolders/inbox") return jsonResponse(folder("inbox-id", { totalItemCount: 1 }));
      if (url.pathname === "/v1.0/me/mailFolders/sentitems") return jsonResponse(folder("sent-id", { totalItemCount: 0 }));
      if (url.pathname === "/v1.0/me/mailFolders/drafts") return jsonResponse(folder("draft-id", { totalItemCount: 0 }));
      if (url.pathname === "/v1.0/me/mailFolders/deleteditems") return jsonResponse(folder("deleted-id", { totalItemCount: 0 }));
      if (url.pathname === "/v1.0/me/mailFolders") return jsonResponse({ value: [
        folder("inbox-id", { totalItemCount: 1 }),
        folder("sent-id", { totalItemCount: 0 }),
        folder("draft-id", { totalItemCount: 0 }),
        folder("deleted-id", { totalItemCount: 0 })
      ] });
      if (url.pathname.endsWith("/sent-id/messages")) return jsonResponse({ value: [] });
      if (url.pathname === "/v1.0/me/messages") return new Response(null, { status: 504 });
      throw new Error("Unexpected Graph request");
    });
    const provider = new MicrosoftProvider("token", {
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0
    });
    let fallbackCount = 0;

    await provider.scanParticipatedConversationIds({ batchSize: 250 });
    await expect(provider.processMetadataWithAdaptiveFallback({
      scan: { batchSize: 250, limit: "full" },
      onBatch() {},
      onFallback() {
        fallbackCount += 1;
      }
    })).rejects.toThrow();

    const mainStarts = requestedUrls.filter(
      (url) => url.pathname === "/v1.0/me/messages" && url.searchParams.has("$select")
    );
    expect(mainStarts.map((url) => url.searchParams.get("$top"))).toEqual(["100"]);
    expect(fallbackCount).toBe(0);
    expect(provider.getScanMetrics()).toMatchObject({
      mainMessagePageSize: 100,
      mainMessagePages: 0,
      mainMessagePageFallbacks: 0,
      failures5xx: 1
    });
  });

  it("retains the 200-message folder scanner only behind an explicit development option", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);
      if (url.pathname === "/v1.0/me/mailFolders/inbox") return jsonResponse(folder("inbox-id", { totalItemCount: 1 }));
      if (url.pathname === "/v1.0/me/mailFolders/sentitems") return jsonResponse(folder("sent-id", { totalItemCount: 0 }));
      if (url.pathname === "/v1.0/me/mailFolders/drafts") return jsonResponse(folder("draft-id", { totalItemCount: 0 }));
      if (url.pathname === "/v1.0/me/mailFolders/deleteditems") return jsonResponse(folder("deleted-id", { totalItemCount: 0 }));
      if (url.pathname === "/v1.0/me/mailFolders") return jsonResponse({ value: [
        folder("inbox-id", { totalItemCount: 1 }),
        folder("sent-id", { totalItemCount: 0 }),
        folder("draft-id", { totalItemCount: 0 }),
        folder("deleted-id", { totalItemCount: 0 })
      ] });
      if (url.pathname === "/v1.0/me/mailFolders/inbox-id/messages") {
        return jsonResponse({ value: [message("inbox-message", "inbox-id", "conversation")] });
      }
      throw new Error(`Unexpected Graph request: ${url.pathname}`);
    });
    const provider = new MicrosoftProvider("token", {
      fetchImpl: fetchImpl as typeof fetch,
      experimentalFolderScan: true
    });

    try {
      for await (const _ of provider.scanMetadata({ batchSize: 250, limit: "full" })) {
        void _;
      }
    } finally {
      vi.unstubAllEnvs();
    }

    const experimentalRequest = requestedUrls.find(
      (url) => url.pathname === "/v1.0/me/mailFolders/inbox-id/messages"
    );
    expect(experimentalRequest?.searchParams.get("$top")).toBe("200");
    expect(requestedUrls.some((url) => url.pathname === "/v1.0/me/messages")).toBe(false);
  });

  it("maps an Outlook follow-up flag to starred hard protection", () => {
    const folders: MicrosoftFolderIndex = {
      knownFolderIds: new Set(["inbox-id"]),
      kindByFolderId: new Map(),
      sentFolderIds: new Set()
    };
    const normalized = normalizeMicrosoftMessage(
      message("flagged-message", "inbox-id", "flagged-conversation", {
        flag: { flagStatus: "flagged" }
      }),
      folders
    );
    const assessment = assessMessage(normalized, { now: new Date("2026-08-31T00:00:00Z") });

    expect(normalized.isStarred).toBe(true);
    expect(assessment.protectionReasons).toContain("PROTECTED_STARRED");
    expect(assessment.eligibleForCleanup).toBe(false);
  });

  it("identifies a rejected first mailbox page as the main message scan phase", async () => {
    const responses = [
      jsonResponse(folder("inbox-id", { totalItemCount: 100 })),
      jsonResponse(folder("sent-id", { totalItemCount: 0 })),
      jsonResponse(folder("draft-id", { totalItemCount: 0 })),
      jsonResponse(folder("deleted-id", { totalItemCount: 0 })),
      jsonResponse({
        value: [
          folder("inbox-id", { totalItemCount: 100 }),
          folder("sent-id", { totalItemCount: 0 }),
          folder("draft-id", { totalItemCount: 0 }),
          folder("deleted-id", { totalItemCount: 0 })
        ]
      }),
      jsonResponse({ value: [{ conversationId: "participated-conversation" }] }),
      new Response("private provider response", { status: 400 })
    ];
    const fetchImpl = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected Graph request");
      return response;
    });
    const provider = new MicrosoftProvider("token", { fetchImpl: fetchImpl as typeof fetch });

    await provider.scanParticipatedConversationIds({ batchSize: 250 });
    const scan = provider
      .scanMetadata({ batchSize: 250, limit: "full" })
      [Symbol.asyncIterator]();
    await expect(scan.next()).rejects.toThrow(/HTTP 400, bad_request/i);

    expect(provider.getScanMetrics()).toMatchObject({
      graphPages: 2,
      requests: 7,
      other4xxFailures: 1,
      lastOther4xxStatus: 400,
      lastOther4xxCategory: "bad_request",
      lastOther4xxOperation: "main_message_scan"
    });
  });

  it("classifies a malformed main-message collection shape without mailbox data", async () => {
    const responses = [
      jsonResponse(folder("inbox-id", { totalItemCount: 1 })),
      jsonResponse(folder("sent-id", { totalItemCount: 0 })),
      jsonResponse(folder("draft-id", { totalItemCount: 0 })),
      jsonResponse(folder("deleted-id", { totalItemCount: 0 })),
      jsonResponse({
        value: [
          folder("inbox-id", { totalItemCount: 1 }),
          folder("sent-id", { totalItemCount: 0 }),
          folder("draft-id", { totalItemCount: 0 }),
          folder("deleted-id", { totalItemCount: 0 })
        ]
      }),
      jsonResponse({ value: [] }),
      jsonResponse({ privateMailboxValue: "must-not-be-recorded" })
    ];
    const fetchImpl = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected Graph request");
      return response;
    });
    const provider = new MicrosoftProvider("token", { fetchImpl: fetchImpl as typeof fetch });

    await provider.scanParticipatedConversationIds({ batchSize: 250 });
    const scan = provider
      .scanMetadata({ batchSize: 250, limit: "full" })
      [Symbol.asyncIterator]();
    await expect(scan.next()).rejects.toThrow("Outlook returned an unexpected response");

    expect(provider.getScanMetrics()).toMatchObject({
      lastNonHttpFailureOperation: "main_message_scan",
      lastNonHttpFailureCategory: "invalid_shape"
    });
    expect(JSON.stringify(provider.getScanMetrics())).not.toContain("must-not-be-recorded");
  });

  it("fails rather than skipping a message without an ID and records normalization", async () => {
    const responses = [
      jsonResponse(folder("inbox-id", { totalItemCount: 1 })),
      jsonResponse(folder("sent-id", { totalItemCount: 0 })),
      jsonResponse(folder("draft-id", { totalItemCount: 0 })),
      jsonResponse(folder("deleted-id", { totalItemCount: 0 })),
      jsonResponse({
        value: [
          folder("inbox-id", { totalItemCount: 1 }),
          folder("sent-id", { totalItemCount: 0 }),
          folder("draft-id", { totalItemCount: 0 }),
          folder("deleted-id", { totalItemCount: 0 })
        ]
      }),
      jsonResponse({ value: [] }),
      jsonResponse({ value: [{ parentFolderId: "inbox-id" }] })
    ];
    const fetchImpl = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected Graph request");
      return response;
    });
    const provider = new MicrosoftProvider("token", { fetchImpl: fetchImpl as typeof fetch });

    await provider.scanParticipatedConversationIds({ batchSize: 250 });
    const scan = provider
      .scanMetadata({ batchSize: 250, limit: "full" })
      [Symbol.asyncIterator]();
    await expect(scan.next()).rejects.toThrow("Outlook returned an unexpected response");

    expect(provider.getScanMetrics()).toMatchObject({
      lastNonHttpFailureOperation: "main_message_scan",
      lastNonHttpFailureCategory: "normalization"
    });
  });

  it("fails closed when required sender metadata is missing", () => {
    const folders: MicrosoftFolderIndex = {
      knownFolderIds: new Set(["inbox-id"]),
      kindByFolderId: new Map(),
      sentFolderIds: new Set()
    };
    const normalized = normalizeMicrosoftMessage({
      id: "missing-sender",
      parentFolderId: "inbox-id",
      receivedDateTime: "2020-01-01T00:00:00Z",
      isRead: true,
      internetMessageHeaders: [
        { name: "List-Id", value: "newsletter.example.test" },
        { name: "X-Private", value: "discarded" }
      ]
    }, folders);
    expect(normalized.hasUncertainMetadata).toBe(true);
    expect(assessMessage(normalized, { now: new Date("2026-08-31T00:00:00Z") }).protectionReasons)
      .toContain("PROTECTED_INCOMPLETE_METADATA");
    expect(JSON.stringify(normalized)).not.toContain("discarded");
  });

  it("accepts nullable optional Graph fields and protects uncertain messages", () => {
    const folders: MicrosoftFolderIndex = {
      knownFolderIds: new Set(["inbox-id"]),
      kindByFolderId: new Map(),
      sentFolderIds: new Set()
    };
    const normalized = normalizeMicrosoftMessage({
      id: "nullable-fields",
      parentFolderId: "inbox-id",
      from: null,
      receivedDateTime: null,
      isRead: null,
      importance: null,
      categories: null,
      subject: null,
      isDraft: null,
      internetMessageHeaders: null
    }, folders);

    expect(normalized.hasUncertainMetadata).toBe(true);
    expect(assessMessage(normalized, { now: new Date("2026-08-31T00:00:00Z") }).protectionReasons)
      .toContain("PROTECTED_INCOMPLETE_METADATA");
  });

});

describe("Microsoft Graph cleanup batching", () => {
  it("reuses encrypted whole-job folder context without resolving folders per batch", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://graph.microsoft.com/v1.0/$batch");
      return jsonResponse({
        responses: [{
          id: "0",
          status: 200,
          headers: {},
          body: message("message-1", "inbox-id", "conversation-1")
        }]
      });
    });
    const provider = new MicrosoftProvider("token", { fetchImpl: fetchImpl as typeof fetch });

    await expect(provider.getCleanupMessages(["message-1"], {
      knownFolderIds: ["inbox-id", "deleted-id"],
      kindByFolderId: [["deleted-id", "deleted"]],
      sentFolderIds: [],
      deletedItemsFolderId: "deleted-id"
    })).resolves.toHaveLength(1);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.getScanMetrics()).toMatchObject({ requests: 1, subrequests: 1 });
  });

  it("submits independent moves and correlates reordered destination IDs", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://graph.microsoft.com/v1.0/$batch");
      const payload = JSON.parse(String(init?.body)) as {
        requests: Array<{
          id: string;
          method: string;
          url: string;
          dependsOn?: string[];
          body: { destinationId: string };
        }>;
      };
      expect(payload.requests).toEqual([
        expect.objectContaining({ id: "0", method: "POST", url: "/me/messages/original-1/move", body: { destinationId: "deleted" } }),
        expect.objectContaining({ id: "1", method: "POST", url: "/me/messages/original-2/move", body: { destinationId: "deleted" } }),
        expect.objectContaining({ id: "2", method: "POST", url: "/me/messages/original-3/move", body: { destinationId: "deleted" } })
      ]);
      expect(payload.requests.every((request) => request.dependsOn === undefined)).toBe(true);
      return jsonResponse({
        responses: [
          { id: "2", status: 201, headers: {}, body: { id: "destination-3" } },
          { id: "0", status: 201, headers: {}, body: { id: "destination-1" } },
          { id: "1", status: 201, headers: {}, body: { id: "destination-2" } }
        ]
      });
    });
    const provider = new MicrosoftProvider("token", { fetchImpl: fetchImpl as typeof fetch });

    await expect(provider.moveCleanupMessages([
      { messageId: "original-1", destinationFolderId: "deleted" },
      { messageId: "original-2", destinationFolderId: "deleted" },
      { messageId: "original-3", destinationFolderId: "deleted" }
    ], "cleanup_move")).resolves.toEqual([
      { outcome: "success", messageId: "destination-1" },
      { outcome: "success", messageId: "destination-2" },
      { outcome: "success", messageId: "destination-3" }
    ]);
    expect(provider.getScanMetrics()).toMatchObject({ requests: 1, subrequests: 3, retries: 0 });
  });
});

function folder(id: string, overrides: Record<string, unknown> = {}) {
  return { id, childFolderCount: 0, totalItemCount: 0, ...overrides };
}

function message(id: string, parentFolderId: string, conversationId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    parentFolderId,
    conversationId,
    receivedDateTime: "2020-01-01T00:00:00Z",
    isRead: false,
    importance: "normal",
    flag: { flagStatus: "notFlagged" },
    categories: [],
    isDraft: false,
    subject: "Weekly news",
    from: { emailAddress: { address: "newsletter@example.test", name: "Newsletter" } },
    internetMessageHeaders: [
      { name: "List-Id", value: "newsletter.example.test" },
      { name: "List-Unsubscribe", value: "<https://example.test/unsubscribe>" },
      { name: "Precedence", value: "bulk" }
    ],
    ...overrides
  };
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init
  });
}
