import { describe, expect, it, vi } from "vitest";
import { GmailScalableCleanupProvider } from "@/lib/providers/gmail/scalable-cleanup-provider";

describe("authoritative scalable Gmail verifier", () => {
  it("completely paginates exact labelsAdded history without unnecessary fallback", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ history: [], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(json({ history: [{ labelsAdded: [{ message: { id: "target" }, labelIds: ["TRASH"] }] }] }));
    const reserve = vi.fn(async () => undefined);
    const provider = new GmailScalableCleanupProvider("token", "mail@example.com", {
      fetchImpl,
      pollAttempts: 1,
      sleepImpl: async () => undefined
    });

    const result = await provider.verifyTrash({ targetIds: ["target"], startHistoryId: "123", reserve });
    expect(result).toMatchObject({
      verifiedIds: ["target"],
      historyVerifiedCount: 1,
      historyPages: 2,
      listRequests: 0,
      getFallbackRequests: 0,
      uncertainIds: []
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toContain("pageToken=page-2");
  });

  it("uses bounded polling for delayed history visibility", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ history: [] }))
      .mockResolvedValueOnce(json({ history: [{ labelsAdded: [{ message: { id: "target" }, labelIds: ["TRASH"] }] }] }));
    const sleepImpl = vi.fn(async () => undefined);
    const provider = new GmailScalableCleanupProvider("token", "mail@example.com", {
      fetchImpl,
      pollAttempts: 2,
      sleepImpl
    });
    const result = await provider.verifyTrash({ targetIds: ["target"], startHistoryId: "123", reserve: async () => undefined });
    expect(result.historyPollAttempts).toBe(2);
    expect(result.verifiedIds).toEqual(["target"]);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it("caps direct fallback at ten and leaves additional targets uncertain", async () => {
    const targets = Array.from({ length: 12 }, (_, index) => `target-${index}`);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ history: [] }))
      .mockResolvedValueOnce(json({ messages: [{ id: "target-0" }] }));
    for (let index = 1; index <= 10; index += 1) {
      fetchImpl.mockResolvedValueOnce(json({ id: `target-${index}`, labelIds: ["TRASH"] }));
    }
    const provider = new GmailScalableCleanupProvider("token", "mail@example.com", {
      fetchImpl,
      pollAttempts: 1,
      sleepImpl: async () => undefined
    });
    const result = await provider.verifyTrash({ targetIds: targets, startHistoryId: "123", reserve: async () => undefined });
    expect(result).toMatchObject({
      historyVerifiedCount: 0,
      listVerifiedCount: 1,
      getVerifiedCount: 10,
      getFallbackRequests: 10,
      uncertainIds: ["target-11"]
    });
    expect(result.verifiedIds).toHaveLength(11);
    expect(result.verifiedIds.length + result.failedIds.length + result.uncertainIds.length).toBe(12);
  });

  it("treats a complete 204 Trash list as empty and keeps unresolved reads bounded", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ history: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ id: "target", labelIds: [] }));
    const provider = new GmailScalableCleanupProvider("token", "mail@example.com", {
      fetchImpl,
      pollAttempts: 1,
      sleepImpl: async () => undefined
    });
    const result = await provider.verifyTrash({ targetIds: ["target"], startHistoryId: "123", reserve: async () => undefined });
    expect(result.failedIds).toEqual(["target"]);
    expect(result.getFallbackRequests).toBe(1);
  });

  it("verifies scalable Undo only from exact labelsRemoved TRASH evidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({
      history: [{
        labelsAdded: [{ message: { id: "target" }, labelIds: ["TRASH"] }],
        labelsRemoved: [
          { message: { id: "other" }, labelIds: ["TRASH"] },
          { message: { id: "target" }, labelIds: ["INBOX"] },
          { message: { id: "target" }, labelIds: ["TRASH"] }
        ]
      }]
    }));
    const provider = new GmailScalableCleanupProvider("token", "mail@example.com", {
      fetchImpl,
      pollAttempts: 1,
      sleepImpl: async () => undefined
    });
    const result = await provider.verifyTrashRemoval({ targetIds: ["target"], startHistoryId: "123", reserve: async () => undefined });
    expect(result).toMatchObject({ verifiedIds: ["target"], historyVerifiedCount: 1, uncertainIds: [] });
    expect(fetchImpl.mock.calls[0][0]).toContain("historyTypes=labelRemoved");
  });

  it("deduplicates repeated exact target history entries", async () => {
    const duplicate = { message: { id: "target" }, labelIds: ["TRASH"] };
    const provider = new GmailScalableCleanupProvider("token", "mail@example.com", {
      fetchImpl: vi.fn().mockResolvedValueOnce(json({ history: [{ labelsAdded: [duplicate, duplicate] }] })),
      pollAttempts: 1,
      sleepImpl: async () => undefined
    });
    const result = await provider.verifyTrash({ targetIds: ["target"], startHistoryId: "123", reserve: async () => undefined });
    expect(result).toMatchObject({ verifiedIds: ["target"], historyVerifiedCount: 1 });
  });
});

describe("development scalable post-state audit", () => {
  it("fully paginates Trash and reports 231 exact messages across 230 distinct threads", async () => {
    const targets = Array.from({ length: 231 }, (_, index) => `target-${index}`);
    const messages = targets.map((id, index) => ({
      id,
      threadId: index < 2 ? "shared-thread" : `thread-${index}`
    }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ messages: [...messages.slice(0, 100), { id: "unrelated", threadId: "other" }], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(json({ messages: [...messages.slice(100), messages[0], { id: "unrelated-2", threadId: "other-2" }] }));
    const reserve = vi.fn(async () => undefined);
    const provider = new GmailScalableCleanupProvider("token", "mail@example.com", { fetchImpl });

    const result = await provider.auditTrashPostState({ targetIds: targets, reserve });

    expect(result).toEqual({
      exactTargetMessagesFoundInTrash: 231,
      exactTargetMessagesAbsentFromTrash: 0,
      distinctGmailThreadCount: 230,
      trashListRequests: 2,
      trashListPages: 2
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain("labelIds=TRASH");
    expect(fetchImpl.mock.calls[1][0]).toContain("pageToken=page-2");
    expect(JSON.stringify(result)).not.toMatch(/target-|shared-thread|unrelated/);
  });

  it("reports an exact target missing from Trash and ignores unrelated messages", async () => {
    const provider = new GmailScalableCleanupProvider("token", "mail@example.com", {
      fetchImpl: vi.fn().mockResolvedValueOnce(json({
        messages: [
          { id: "target-1", threadId: "thread-1" },
          { id: "unrelated", threadId: "thread-other" }
        ]
      }))
    });
    expect(await provider.auditTrashPostState({
      targetIds: ["target-1", "target-2"],
      reserve: async () => undefined
    })).toEqual({
      exactTargetMessagesFoundInTrash: 1,
      exactTargetMessagesAbsentFromTrash: 1,
      distinctGmailThreadCount: 1,
      trashListRequests: 1,
      trashListPages: 1
    });
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
