import { describe, expect, it, vi } from "vitest";
import {
  GmailCandidateResolutionStageError,
  GmailTrashClient
} from "@/lib/providers/gmail/gmail-api-client";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("controlled Gmail batch mutation", () => {
  it("sends exactly 100 native ids in one batchModify request", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl, sleepImpl: async () => undefined });
    const ids = Array.from({ length: 100 }, (_, index) => `native-${index}`);

    await client.batchModifyTrash(ids);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toMatch(/\/messages\/batchModify$/);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      ids,
      addLabelIds: ["TRASH"],
      removeLabelIds: []
    });
  });

  it("rejects 101 ids before making a provider request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl });

    await expect(client.batchModifyTrash(Array.from({ length: 101 }, (_, index) => `native-${index}`))).rejects.toThrow(/between 1 and 100/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("authoritative Gmail candidate resolution", () => {
  it("returns only individually Ready messages and aggregates final exclusion reasons", async () => {
    const ids = ["eligible", "starred", "subject", "participated", "mismatch", "no-strong"];
    const metadata = new Map<string, Record<string, unknown>>(
      ids.map((id) => [
        id,
        {
          id,
          threadId: id === "participated" ? "participated-thread" : `thread-${id}`,
          labelIds: id === "starred" ? ["STARRED"] : [],
          internalDate: String(Date.parse("2024-01-01T00:00:00Z")),
          payload: {
            headers: [
              {
                name: "From",
                value: id === "mismatch" ? "Other <other@example.test>" : "Deals <deals@example.test>"
              },
              ...(id === "no-strong" ? [] : [{ name: "List-Id", value: "offers.example" }]),
              ...(id === "subject" ? [{ name: "Subject", value: "Security alert for your account" }] : [])
            ]
          }
        }
      ])
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.searchParams.has("q")) return jsonResponse({ messages: ids.map((id) => ({ id })) });
      const id = parsed.pathname.split("/").at(-1)!;
      return jsonResponse(metadata.get(id));
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl, sleepImpl: async () => undefined });

    const result = await client.resolveCleanupCandidatesForSender({
      senderAddress: "deals@example.test",
      limit: 5,
      participatedConversationIds: new Set(["participated-thread"]),
      now: new Date("2026-08-26T12:00:00Z")
    });

    expect(result.candidates).toEqual([
      { apiMessageId: "eligible", requiresMutableStrongEvidenceRecheck: false }
    ]);
    expect(result.excludedMessageCount).toBe(5);
    expect(result.exclusionCounts).toMatchObject({
      STARRED: 1,
      PROTECTED_SUBJECT: 1,
      PARTICIPATED_CONVERSATION: 1,
      SENDER_MISMATCH: 1,
      STRONG_EVIDENCE_MISSING: 1
    });
  });

  it("preserves request accounting and stage context when one metadata recheck fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.searchParams.has("q")) {
        return jsonResponse({ messages: [{ id: "safe" }, { id: "broken" }] });
      }
      if (parsed.pathname.endsWith("/broken")) return jsonResponse({}, 400);
      return jsonResponse({
        id: "safe",
        threadId: "safe-thread",
        labelIds: ["CATEGORY_PROMOTIONS"],
        internalDate: String(Date.parse("2024-01-01T00:00:00Z")),
        payload: { headers: [{ name: "From", value: "Deals <deals@example.test>" }] }
      });
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl, sleepImpl: async () => undefined });

    await expect(
      client.resolveCleanupCandidatesForSender({
        senderAddress: "deals@example.test",
        limit: 2,
        participatedConversationIds: new Set(),
        now: new Date("2026-08-25T12:00:00Z")
      })
    ).rejects.toBeInstanceOf(GmailCandidateResolutionStageError);
    expect(client.getRequestProfile()).toMatchObject({
      requestCount: 3,
      estimatedQuotaUnits: 45,
      requests: { list: 1, previewMetadata: 2 }
    });
  });

  it("runs messages.list through bounded retry and preserves its request accounting", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "safe" }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "safe",
          threadId: "safe-thread",
          labelIds: [],
          internalDate: String(Date.parse("2024-01-01T00:00:00Z")),
          payload: {
            headers: [
              { name: "From", value: "Deals <deals@example.test>" },
              { name: "List-Id", value: "offers.example" }
            ]
          }
        })
      ) as unknown as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      retryAttempts: 2
    });

    await expect(
      client.resolveCleanupCandidatesForSender({
        senderAddress: "deals@example.test",
        limit: 1,
        participatedConversationIds: new Set(),
        now: new Date("2026-08-25T12:00:00Z")
      })
    ).resolves.toMatchObject({ candidates: [{ apiMessageId: "safe" }] });
    expect(client.getRequestProfile()).toMatchObject({
      requestCount: 3,
      retryCount: 1,
      requests: { list: 2, previewMetadata: 1 }
    });
  });

  it("classifies a messages.list 400 without retaining the Gmail query or provider body", async () => {
    const secret = "private provider body";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: secret, errors: [{ reason: "invalidArgument" }] } }, 400)
    ) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl, sleepImpl: async () => undefined });

    const error = await client
      .resolveCleanupCandidatesForSender({
        senderAddress: "deals@example.test",
        limit: 1,
        participatedConversationIds: new Set(),
        now: new Date("2026-08-25T12:00:00Z")
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      stage: "list",
      cause: {
        reason: "GMAIL_INVALID_QUERY",
        status: 400,
        retryable: false,
        retriesAttempted: 0
      }
    });
    expect(JSON.stringify(error)).not.toMatch(/private provider body|from%3A|deals%40example/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("normalizes a messages.list 204 without reading JSON, retrying, or producing candidates", async () => {
    const response = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(response, "json");
    const fetchImpl = vi.fn(async () => response) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl, sleepImpl: async () => undefined });

    const result = await client.resolveCleanupCandidatesForSender({
      senderAddress: "deals@example.test",
      limit: 1,
      participatedConversationIds: new Set(),
      now: new Date("2026-08-25T12:00:00Z")
    });

    expect(result).toMatchObject({ candidates: [], excludedMessageCount: 0 });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.getRequestProfile()).toMatchObject({
      requestCount: 1,
      retryCount: 0,
      requests: { list: 1, previewMetadata: 0 }
    });
  });

  it.each([
    ["omitted messages", {}],
    ["empty messages", { messages: [] }]
  ])("normalizes a valid messages.list 200 response with %s to zero candidates", async (_case, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body)) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl, sleepImpl: async () => undefined });

    await expect(
      client.resolveCleanupCandidatesForSender({
        senderAddress: "deals@example.test",
        limit: 1,
        participatedConversationIds: new Set(),
        now: new Date("2026-08-25T12:00:00Z")
      })
    ).resolves.toMatchObject({ candidates: [], excludedMessageCount: 0 });
    expect(client.getRequestProfile().requests).toMatchObject({ list: 1, previewMetadata: 0 });
  });

  it.each([
    ["malformed JSON", () => new Response("not-json private body", { status: 200 })],
    ["unexpected shape", () => jsonResponse({ messages: "not-an-array", privateValue: "hidden" })]
  ] as const)("classifies a messages.list %s success response without leaking its contents", async (_case, response) => {
    const fetchImpl = vi.fn(async () => response()) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl, sleepImpl: async () => undefined });

    const error = await client
      .resolveCleanupCandidatesForSender({
        senderAddress: "deals@example.test",
        limit: 1,
        participatedConversationIds: new Set(),
        now: new Date("2026-08-25T12:00:00Z")
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      stage: "list",
      cause: {
        reason: "GMAIL_RESPONSE_INVALID",
        status: 200,
        retryable: false,
        retriesAttempted: 0
      }
    });
    expect(JSON.stringify(error)).not.toMatch(/not-json private body|not-an-array|hidden|deals@example/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrent full metadata checks and profiles requests without request values", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `eligible-${index}`);
    let active = 0;
    let maximumActive = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.searchParams.has("q")) return jsonResponse({ messages: ids.map((id) => ({ id })) });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const id = parsed.pathname.split("/").at(-1)!;
      return jsonResponse({
        id,
        threadId: `thread-${id}`,
        labelIds: [],
        internalDate: String(Date.parse("2024-01-01T00:00:00Z")),
        payload: { headers: [{ name: "From", value: "Deals <deals@example.test>" }, { name: "List-Id", value: "offers.example" }] }
      });
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl, requestConcurrency: 4 });

    const result = await client.resolveCleanupCandidatesForSender({
      senderAddress: "deals@example.test",
      limit: 20,
      participatedConversationIds: new Set(),
      now: new Date("2026-08-26T12:00:00Z")
    });
    const profile = client.getRequestProfile();

    expect(result.candidates).toHaveLength(20);
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(profile).toMatchObject({ requestCount: 21, peakConcurrency: 4, estimatedQuotaUnits: 405 });
    expect(profile.requests).toMatchObject({ list: 1, previewMetadata: 20 });
    expect(profile).not.toHaveProperty("urls");
  });
});

describe("optimized confirmation recheck", () => {
  it("uses one current sender query and does not refetch stable headers for unchanged candidates", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ messages: [{ id: "stable" }] })) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl });

    const result = await client.recheckCleanupCandidates([
      {
        senderAddress: "deals@example.test",
        candidates: [{ apiMessageId: "stable", requiresMutableStrongEvidenceRecheck: false }]
      }
    ]);

    expect(result).toMatchObject({ eligibleIds: ["stable"], excludedMessageCount: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.getRequestProfile().requests).toMatchObject({ list: 1, previewMetadata: 0, confirmationLabels: 0 });
  });

  it("label-checks Promotions-dependent and missing candidates and refuses unsafe changes", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.searchParams.has("q")) return jsonResponse({ messages: [{ id: "promo" }] });
      const id = parsed.pathname.split("/").at(-1)!;
      if (id === "promo") return jsonResponse({ labelIds: ["CATEGORY_PROMOTIONS", "STARRED"] });
      return jsonResponse({ labelIds: ["IMPORTANT"] });
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", { fetchImpl });

    const result = await client.recheckCleanupCandidates([
      {
        senderAddress: "deals@example.test",
        candidates: [
          { apiMessageId: "promo", requiresMutableStrongEvidenceRecheck: true },
          { apiMessageId: "missing", requiresMutableStrongEvidenceRecheck: false }
        ]
      }
    ]);

    expect(result.eligibleIds).toEqual([]);
    expect(result.exclusionCounts).toMatchObject({ STARRED: 1, IMPORTANT: 1 });
    expect(client.getRequestProfile().requests).toMatchObject({ list: 1, confirmationLabels: 2, previewMetadata: 0 });
  });
});

describe("Gmail verification", () => {
  it("verifies 100 messages with bounded concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return jsonResponse({ labelIds: ["TRASH"] });
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      verificationConcurrency: 5
    });

    const result = await client.verifyMessagesInTrash(
      Array.from({ length: 100 }, (_, index) => `native-${index}`)
    );

    expect(result).toMatchObject({ attemptedCount: 100, verifiedCount: 100, failedCount: 0, uncertainCount: 0 });
    expect(maximumActive).toBeLessThanOrEqual(5);
  });

  it("keeps failed and uncertain verification outcomes distinct", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("uncertain")) throw new TypeError("temporary connection reset");
      if (value.includes("failed")) return jsonResponse({ labelIds: [] });
      return jsonResponse({ labelIds: ["TRASH"] });
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      retryAttempts: 2
    });

    const result = await client.verifyMessagesInTrash(["verified", "failed", "uncertain"]);
    expect(result).toMatchObject({ attemptedCount: 3, verifiedCount: 1, failedCount: 1, uncertainCount: 1 });
  });

  it("retries transient statuses and transport failures but not permission denial", async () => {
    const transientFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ id: "native", payload: { headers: [] } }));
    const transientClient = new GmailTrashClient("test-token", {
      fetchImpl: transientFetch as typeof fetch,
      sleepImpl: async () => undefined
    });

    await expect(transientClient.getMinimalMessageMetadata("native")).resolves.toMatchObject({ id: "native" });
    expect(transientFetch).toHaveBeenCalledTimes(3);

    const deniedFetch = vi.fn(async () => new Response(null, { status: 403 }));
    const deniedClient = new GmailTrashClient("test-token", {
      fetchImpl: deniedFetch as unknown as typeof fetch,
      sleepImpl: async () => undefined
    });
    await expect(deniedClient.getMinimalMessageMetadata("native")).rejects.toMatchObject({
      transient: false,
      status: 403
    });
    expect(deniedFetch).toHaveBeenCalledTimes(1);
  });

  it("turns request timeouts into bounded transient retries", async () => {
    const timeoutFetch = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
        })
      )
      .mockResolvedValueOnce(jsonResponse({ id: "native", payload: { headers: [] } }));
    const client = new GmailTrashClient("test-token", {
      fetchImpl: timeoutFetch as typeof fetch,
      sleepImpl: async () => undefined,
      requestTimeoutMs: 2
    });

    await expect(client.getMinimalMessageMetadata("native")).resolves.toMatchObject({ id: "native" });
    expect(timeoutFetch).toHaveBeenCalledTimes(2);
  });
});

describe("Gmail provider failure retry integration", () => {
  it.each([
    [400, "GMAIL_INVALID_QUERY", false],
    [403, "GMAIL_PERMISSION_DENIED", false],
    [429, "GMAIL_TOO_MANY_REQUESTS", true],
    [500, "GMAIL_PROVIDER_5XX", true]
  ])("retains HTTP %i when the provider error body is malformed", async (status, reason, retryable) => {
    const fetchImpl = vi.fn(async () => new Response("malformed private body", { status })) as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      retryAttempts: 1
    });

    const error = await client.getMinimalMessageMetadata("private-id").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason, status, retryable, retriesAttempted: 0 });
    expect(JSON.stringify(error)).not.toContain("malformed private body");
  });

  it.each(["rateLimitExceeded", "userRateLimitExceeded"])(
    "retries a structured 403 %s response",
    async (reason) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: { errors: [{ reason }] } }, 403))
        .mockResolvedValueOnce(jsonResponse({ id: "native", payload: { headers: [] } })) as unknown as typeof fetch;
      const client = new GmailTrashClient("test-token", {
        fetchImpl,
        sleepImpl: async () => undefined,
        retryAttempts: 2
      });

      await expect(client.getMinimalMessageMetadata("native")).resolves.toMatchObject({ id: "native" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(client.getRequestProfile().retryCount).toBe(1);
    }
  );

  it.each([
    ["domainPolicy", "GMAIL_DOMAIN_POLICY"],
    ["dailyLimitExceeded", "GMAIL_DAILY_LIMIT"],
    ["unknownPermissionReason", "GMAIL_PERMISSION_DENIED"]
  ])("does not retry a structured 403 %s response", async (reason, expectedReason) => {
    const secret = "provider body detail must not escape";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: secret, errors: [{ reason, message: secret }] } }, 403)
    ) as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      retryAttempts: 4
    });

    const error = await client.getMinimalMessageMetadata("native").catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      reason: expectedReason,
      status: 403,
      retryable: false,
      retriesAttempted: 0
    });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports bounded retry exhaustion for structured 403 rate limiting", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403)
    ) as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      retryAttempts: 2
    });

    await expect(client.getMinimalMessageMetadata("native")).rejects.toMatchObject({
      reason: "GMAIL_USER_RATE_LIMITED",
      status: 403,
      retryable: true,
      retriesAttempted: 1
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.getRequestProfile().retryCount).toBe(1);
  });

  it.each([
    [400, "GMAIL_INVALID_QUERY"],
    [401, "GMAIL_AUTHENTICATION_FAILED"],
    [404, "GMAIL_NOT_FOUND"],
    [418, "GMAIL_UNKNOWN_PROVIDER_ERROR"]
  ])("does not retry HTTP %i", async (status, reason) => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, status)) as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined
    });

    await expect(client.getMinimalMessageMetadata("native")).rejects.toMatchObject({
      reason,
      status,
      retryable: false,
      retriesAttempted: 0
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies exhausted network retries without retaining transport details", async () => {
    const secret = "private socket detail";
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(secret);
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      retryAttempts: 2
    });

    const error = await client.getMinimalMessageMetadata("native").catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      reason: "GMAIL_NETWORK_ERROR",
      status: undefined,
      retryable: true,
      retriesAttempted: 1
    });
    expect(String(error)).not.toContain(secret);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("classifies an exhausted timeout with no HTTP status", async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("private timeout", "AbortError")));
      })
    ) as unknown as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      retryAttempts: 2,
      requestTimeoutMs: 1
    });

    await expect(client.getMinimalMessageMetadata("private-id")).rejects.toMatchObject({
      reason: "GMAIL_TIMEOUT",
      status: undefined,
      retryable: true,
      retriesAttempted: 1
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("Gmail verified Undo", () => {
  it("verifies 100 restores from untrash responses with no fallback reads", async () => {
    let untrashRequests = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(url)).toContain("untrash?fields=id,labelIds");
      untrashRequests += 1;
      return jsonResponse({ id: String(url), labelIds: ["INBOX"] });
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      verificationConcurrency: 5
    });
    const ids = Array.from({ length: 100 }, (_, index) => `native-${index}`);

    const result = await client.untrashAndVerifyMessages(ids);

    expect(untrashRequests).toBe(100);
    expect(result).toMatchObject({
      attemptedCount: 100,
      verifiedCount: 100,
      failedCount: 0,
      uncertainCount: 0,
      fallbackVerificationCount: 0
    });
    expect(client.getRequestProfile()).toMatchObject({
      requestCount: 100,
      estimatedQuotaUnits: 500,
      requests: { untrash: 100, undoFallbackLabels: 0 }
    });
  });

  it("uses label reads only when an untrash response omits label state", async () => {
    let fallbackRequests = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (init?.method === "POST") {
        if (value.includes("response-failed")) return jsonResponse({ labelIds: ["TRASH"] });
        if (value.includes("fallback")) return jsonResponse({ id: "fallback" });
        return jsonResponse({ labelIds: ["INBOX"] });
      }
      fallbackRequests += 1;
      if (value.includes("fallback-failed")) return jsonResponse({ labelIds: ["TRASH"] });
      if (value.includes("fallback-uncertain")) return jsonResponse({ id: "fallback-uncertain" });
      return jsonResponse({ labelIds: ["INBOX"] });
    }) as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined
    });

    const result = await client.untrashAndVerifyMessages([
      "response-restored",
      "response-failed",
      "fallback-restored",
      "fallback-failed",
      "fallback-uncertain"
    ]);

    expect(fallbackRequests).toBe(3);
    expect(result).toMatchObject({
      attemptedCount: 5,
      verifiedCount: 2,
      failedCount: 2,
      uncertainCount: 1,
      fallbackVerificationCount: 3
    });
    expect(client.getRequestProfile()).toMatchObject({
      estimatedQuotaUnits: 85,
      requests: { untrash: 5, undoFallbackLabels: 3 }
    });
  });

  it("retries transient untrash failures and accounts for every provider request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({ labelIds: ["INBOX"] })) as unknown as typeof fetch;
    const client = new GmailTrashClient("test-token", {
      fetchImpl,
      sleepImpl: async () => undefined,
      retryAttempts: 2
    });

    const result = await client.untrashAndVerifyMessages(["restored-after-retry"]);

    expect(result).toMatchObject({ verifiedCount: 1, failedCount: 0, uncertainCount: 0 });
    expect(client.getRequestProfile()).toMatchObject({
      requestCount: 2,
      retryCount: 1,
      estimatedQuotaUnits: 10,
      requests: { untrash: 2, undoFallbackLabels: 0 }
    });
  });

  it("reports a failed Undo when every returned message remains in Trash", async () => {
    const client = new GmailTrashClient("test-token", {
      fetchImpl: vi.fn(async () => jsonResponse({ labelIds: ["TRASH"] })) as typeof fetch,
      sleepImpl: async () => undefined
    });

    const result = await client.untrashAndVerifyMessages(["still-trashed-1", "still-trashed-2"]);

    expect(result).toMatchObject({ attemptedCount: 2, verifiedCount: 0, failedCount: 2, uncertainCount: 0 });
    expect(result.attemptedCount).toBe(result.verifiedCount + result.failedCount + result.uncertainCount);
  });
});
