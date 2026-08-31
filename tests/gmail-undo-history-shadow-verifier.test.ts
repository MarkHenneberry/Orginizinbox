import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GmailUndoHistoryShadowVerifier,
  collectTrashRemovalMatches
} from "@/lib/providers/gmail/undo-history-shadow-verifier";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Gmail Undo labelsRemoved history shadow", () => {
  it("captures the transient pre-mutation history checkpoint", async () => {
    const verifier = new GmailUndoHistoryShadowVerifier("token", {
      fetchImpl: async () => json({ historyId: "123" })
    });
    await expect(verifier.captureStartHistoryId()).resolves.toBe("123");
  });

  it("recognizes only exact target ID plus labelsRemoved TRASH", () => {
    const matches = collectTrashRemovalMatches(new Set(["a", "b"]), [{
      history: [
        { labelsAdded: [{ message: { id: "a" }, labelIds: ["TRASH"] }] },
        { labelsRemoved: [{ message: { id: "a" }, labelIds: ["STARRED"] }] },
        { labelsRemoved: [{ message: { id: "other" }, labelIds: ["TRASH"] }] },
        { labelsRemoved: [{ message: { id: "a" }, labelIds: ["TRASH"] }] }
      ]
    }]);
    expect([...matches]).toEqual(["a"]);
  });

  it("follows pagination and deduplicates repeated history evidence", async () => {
    const verifier = new GmailUndoHistoryShadowVerifier("token", {
      pollAttempts: 1,
      fetchImpl: async (url) => String(url).includes("pageToken=two")
        ? json({ history: [{ labelsRemoved: [{ message: { id: "b" }, labelIds: ["TRASH"] }] }] })
        : json({
          history: [{ labelsRemoved: [
            { message: { id: "a" }, labelIds: ["TRASH"] },
            { message: { id: "a" }, labelIds: ["TRASH"] }
          ] }],
          nextPageToken: "two"
        })
    });
    const result = await verifier.verifyTrashRemovalShadow({
      targetIds: ["a", "b"],
      startHistoryId: "100",
      primaryRestoredIds: new Set(["a", "b"])
    });
    expect(result).toMatchObject({
      verifiedByHistory: 2,
      verifiedByGetFallback: 0,
      unresolvedCount: 0,
      mismatchWithPrimaryCount: 0,
      metrics: { historyListRequests: 2, historyPages: 2 }
    });
  });

  it("polls with bounded backoff for delayed history visibility", async () => {
    let historyCalls = 0;
    let sleeps = 0;
    const verifier = new GmailUndoHistoryShadowVerifier("token", {
      pollAttempts: 2,
      sleepImpl: async () => { sleeps += 1; },
      fetchImpl: async (url) => {
        if (String(url).includes("/history")) {
          historyCalls += 1;
          return historyCalls === 1
            ? json({ history: [] })
            : json({ history: [{ labelsRemoved: [{ message: { id: "a" }, labelIds: ["TRASH"] }] }] });
        }
        return json({ id: "a", labelIds: ["TRASH"] });
      }
    });
    const result = await verifier.verifyTrashRemovalShadow({
      targetIds: ["a"],
      startHistoryId: "100",
      primaryRestoredIds: new Set(["a"])
    });
    expect(result.verifiedByHistory).toBe(1);
    expect(result.metrics.historyPollAttempts).toBe(2);
    expect(sleeps).toBe(1);
  });

  it("treats history 404 as unavailable and limits exact fallback reads to ten", async () => {
    const targets = Array.from({ length: 25 }, (_, index) => `target-${index}`);
    const verifier = new GmailUndoHistoryShadowVerifier("token", {
      pollAttempts: 1,
      fetchImpl: async (url) => {
        const value = String(url);
        if (value.includes("/history")) return json({}, 404);
        const id = decodeURIComponent(value.match(/\/messages\/([^?]+)/)?.[1] ?? "");
        return json({ id, labelIds: ["INBOX"] });
      }
    });
    const result = await verifier.verifyTrashRemovalShadow({
      targetIds: targets,
      startHistoryId: "100",
      primaryRestoredIds: new Set(targets)
    });
    expect(result).toMatchObject({
      historyUnavailable: true,
      verifiedByHistory: 0,
      verifiedByGetFallback: 10,
      unresolvedCount: 15,
      mismatchWithPrimaryCount: 0,
      metrics: { historyPollAttempts: 1, getFallbackRequests: 10 }
    });
  });

  it("separates missing shadow evidence from false-positive mismatch", async () => {
    const unresolvedVerifier = new GmailUndoHistoryShadowVerifier("token", {
      pollAttempts: 1,
      fetchImpl: async (url) => String(url).includes("/history")
        ? json({ history: [] })
        : json({ id: "a", labelIds: ["TRASH"] })
    });
    const unresolved = await unresolvedVerifier.verifyTrashRemovalShadow({
      targetIds: ["a"],
      startHistoryId: "100",
      primaryRestoredIds: new Set(["a"])
    });
    expect(unresolved).toMatchObject({ unresolvedCount: 1, mismatchWithPrimaryCount: 0 });

    const mismatchVerifier = new GmailUndoHistoryShadowVerifier("token", {
      pollAttempts: 1,
      fetchImpl: async () => json({
        history: [{ labelsRemoved: [{ message: { id: "b" }, labelIds: ["TRASH"] }] }]
      })
    });
    const mismatch = await mismatchVerifier.verifyTrashRemovalShadow({
      targetIds: ["a", "b"],
      startHistoryId: "100",
      primaryRestoredIds: new Set(["a"])
    });
    expect(mismatch.mismatchWithPrimaryCount).toBe(1);
  });

  it("bounds transient retries and records them", async () => {
    let calls = 0;
    const verifier = new GmailUndoHistoryShadowVerifier("token", {
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

  it("keeps identifiers, history checkpoints, tokens, and mailbox data out of aggregate output", () => {
    const source = readFileSync("src/lib/providers/gmail/undo-history-shadow-verifier.ts", "utf8");
    const output = source.slice(source.indexOf("return {\n      targetCount"), source.indexOf("private async collectHistoryPages"));
    expect(output).not.toMatch(/targetIds|startHistoryId|accessToken|subject|headers|query|historyId/i);
  });
});
