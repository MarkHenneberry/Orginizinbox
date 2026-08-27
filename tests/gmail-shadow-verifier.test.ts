import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GmailShadowVerifier, assertGmailShadowProofInput } from "@/lib/providers/gmail/shadow-verifier";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Gmail history shadow verifier", () => {
  it("captures a valid pre-mutation history checkpoint", async () => {
    const verifier = new GmailShadowVerifier("token", { fetchImpl: async () => json({ historyId: "123" }) });
    await expect(verifier.captureStartHistoryId()).resolves.toBe("123");
  });

  it("requires exact target ID plus TRASH label, ignores unrelated activity, duplicates, and follows pagination", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("pageToken=two")) {
        return json({ history: [{ labelsAdded: [{ message: { id: "b" }, labelIds: ["TRASH"] }] }] });
      }
      return json({
        history: [
          { labelsAdded: [{ message: { id: "unrelated" }, labelIds: ["TRASH"] }] },
          { labelsAdded: [{ message: { id: "a" }, labelIds: ["STARRED"] }] },
          { labelsAdded: [{ message: { id: "a" }, labelIds: ["TRASH"] }, { message: { id: "a" }, labelIds: ["TRASH"] }] }
        ],
        nextPageToken: "two"
      });
    };
    const verifier = new GmailShadowVerifier("token", { fetchImpl, pollAttempts: 1 });
    const result = await verifier.verifyTrashShadow({
      targetIds: ["a", "b"],
      startHistoryId: "100",
      primaryVerifiedIds: new Set(["a", "b"])
    });
    expect(result).toMatchObject({
      verifiedByHistory: 2,
      verifiedByTrashList: 0,
      unresolvedCount: 0,
      mismatchWithPrimaryCount: 0,
      metrics: { historyListRequests: 2, historyPages: 2 }
    });
  });

  it("polls boundedly through a delayed empty result", async () => {
    let historyCalls = 0;
    let sleeps = 0;
    const verifier = new GmailShadowVerifier("token", {
      pollAttempts: 2,
      sleepImpl: async () => { sleeps += 1; },
      fetchImpl: async (url) => {
        if (String(url).includes("/history")) {
          historyCalls += 1;
          return historyCalls === 1
            ? json({ history: [] })
            : json({ history: [{ labelsAdded: [{ message: { id: "a" }, labelIds: ["TRASH"] }] }] });
        }
        return json({ messages: [] });
      }
    });
    const result = await verifier.verifyTrashShadow({ targetIds: ["a"], startHistoryId: "100" });
    expect(result.verifiedByHistory).toBe(1);
    expect(result.metrics.historyPollAttempts).toBe(2);
    expect(sleeps).toBe(1);
  });

  it("handles history 404 and verifies unresolved targets through complete Trash pagination", async () => {
    const verifier = new GmailShadowVerifier("token", {
      fetchImpl: async (url) => {
        const value = String(url);
        if (value.includes("/history")) return json({}, 404);
        if (value.includes("pageToken=two")) return json({ messages: [{ id: "b" }] });
        return json({ messages: [{ id: "a" }], nextPageToken: "two" });
      }
    });
    const result = await verifier.verifyTrashShadow({ targetIds: ["a", "b"], startHistoryId: "100" });
    expect(result).toMatchObject({
      historyUnavailable: true,
      verifiedByHistory: 0,
      verifiedByTrashList: 2,
      unresolvedCount: 0,
      metrics: { trashListPages: 2 }
    });
  });

  it("limits messages.get fallback to ten and leaves larger unresolved sets Uncertain", async () => {
    const targets = Array.from({ length: 12 }, (_, index) => `target-${index}`);
    const verifier = new GmailShadowVerifier("token", {
      pollAttempts: 1,
      fetchImpl: async (url) => {
        const value = String(url);
        if (value.includes("/history")) return json({ history: [] });
        if (value.includes("/messages?")) return json({ messages: [] });
        const id = decodeURIComponent(value.match(/\/messages\/([^?]+)/)?.[1] ?? "");
        return json({ id, labelIds: ["TRASH"] });
      }
    });
    const result = await verifier.verifyTrashShadow({ targetIds: targets, startHistoryId: "100" });
    expect(result).toMatchObject({
      getFallbackRequired: 12,
      verifiedByGetFallback: 10,
      unresolvedCount: 2,
      metrics: { getFallbackRequests: 10 }
    });
  });

  it("reports shadow mismatch without changing the supplied primary result", async () => {
    const primary = new Set(["a", "b"]);
    const verifier = new GmailShadowVerifier("token", {
      pollAttempts: 1,
      fetchImpl: async (url) => String(url).includes("/history")
        ? json({ history: [{ labelsAdded: [{ message: { id: "a" }, labelIds: ["TRASH"] }] }] })
        : json({ messages: [] })
    });
    const result = await verifier.verifyTrashShadow({ targetIds: ["a", "b"], startHistoryId: "100", primaryVerifiedIds: primary });
    expect(result.mismatchWithPrimaryCount).toBe(1);
    expect([...primary]).toEqual(["a", "b"]);
  });

  it("retries rate limits and provider failures with bounded backoff", async () => {
    let calls = 0;
    const verifier = new GmailShadowVerifier("token", {
      sleepImpl: async () => undefined,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return json({}, 429);
        if (calls === 2) return json({}, 503);
        return json({ historyId: "123" });
      }
    });
    await expect(verifier.captureStartHistoryId()).resolves.toBe("123");
    expect(calls).toBe(3);
  });

  it("bounds request time and leaves a failed get fallback unresolved", async () => {
    const verifier = new GmailShadowVerifier("token", {
      pollAttempts: 1,
      retryAttempts: 1,
      requestTimeoutMs: 1,
      fetchImpl: async (url, init) => {
        const value = String(url);
        if (value.includes("/history")) return json({ history: [] });
        if (value.includes("/messages?")) return json({ messages: [] });
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
    });
    const result = await verifier.verifyTrashShadow({ targetIds: ["a"], startHistoryId: "100" });
    expect(result).toMatchObject({ verifiedByGetFallback: 0, unresolvedCount: 1 });
  });

  it("keeps identifiers, tokens, queries, and mailbox metadata out of aggregate shadow output", () => {
    const source = readFileSync("src/lib/providers/gmail/shadow-verifier.ts", "utf8");
    const summaryShape = source.slice(source.indexOf("return {\n      targetCount"), source.indexOf("private async collectHistoryPages"));
    expect(summaryShape).not.toMatch(/targetIds|accessToken|startHistoryId|subject|headers|query/i);
  });

  it("hard-gates the prepared shadow proof to 25 unique messages outside production", () => {
    const ids = Array.from({ length: 25 }, (_, index) => `id-${index}`);
    expect(assertGmailShadowProofInput({ enabled: true, nodeEnv: "development", targetIds: ids })).toEqual(ids);
    expect(() => assertGmailShadowProofInput({ enabled: true, nodeEnv: "development", targetIds: ids.slice(0, 24) })).toThrow(/exactly 25/);
    expect(() => assertGmailShadowProofInput({ enabled: false, nodeEnv: "development", targetIds: ids })).toThrow(/disabled/);
    expect(() => assertGmailShadowProofInput({ enabled: true, nodeEnv: "production", targetIds: ids })).toThrow(/disabled/);
  });

  it("keeps the current verifier authoritative and stores only aggregate shadow diagnostics", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const store = readFileSync("src/lib/server/gmail-cleanup-store.ts", "utf8");
    expect(cleanup.indexOf("verifyMessagesInTrash(eligibleIds)")).toBeLessThan(cleanup.indexOf("completeHistoryShadow(shadow"));
    expect(cleanup).toMatch(/status: fullyVerified \? "completed"/);
    expect(cleanup).not.toMatch(/status:.*shadowVerification/);
    expect(store).toMatch(/shadowVerification: job\.shadowVerification \? \{ \.\.\.job\.shadowVerification \} : undefined/);
    expect(store).not.toMatch(/shadow.*Ids/i);
  });
});
