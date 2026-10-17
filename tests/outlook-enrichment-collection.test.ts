import { describe, expect, it, vi } from "vitest";
import { MicrosoftProvider, microsoftMessageSelect, type MicrosoftCleanupSafetyContext } from "@/lib/providers/microsoft/provider";
import { applyOutlookCollectionRecord, applyOutlookEvidence, createOutlookProgressiveState, snapshotOutlookProgressive } from "@/lib/domain/outlook-progressive";
import type { NormalizedMailboxRecord } from "@/lib/domain/types";

const folders: MicrosoftCleanupSafetyContext = {
  knownFolderIds: ["inbox", "deleted", "sent", "draft"],
  kindByFolderId: [["deleted", "deleted"], ["sent", "sent"], ["draft", "draft"]],
  sentFolderIds: ["sent"], deletedItemsFolderId: "deleted"
};
const base = (id: string): NormalizedMailboxRecord => ({ provider: "microsoft", providerMessageId: id,
  senderAddress: "newsletter@example.test", receivedAt: new Date("2020-01-01"), isRead: false });
const message = (id: string, overrides: Record<string, unknown> = {}) => ({ id, conversationId: "conversation", parentFolderId: "inbox",
  from: { emailAddress: { address: "newsletter@example.test" } }, receivedDateTime: "2020-01-01T00:00:00Z", isRead: false,
  importance: "normal", flag: { flagStatus: "notFlagged" }, categories: [], isDraft: false, subject: "Private weekly subject",
  internetMessageHeaders: [{ name: "List-Unsubscribe", value: "private-header" }, { name: "X-Private", value: "private-other-header" }], ...overrides });
const json = (value: unknown) => new Response(JSON.stringify(value));

describe("Outlook full-header enrichment collection", () => {
  it("requests the unchanged full select at 500, follows the exact sequential cursor, and joins pending IDs only", async () => {
    const cursor = "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=private-cursor";
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ value: [message("a"), message("not-a-candidate")], "@odata.nextLink": cursor }))
      .mockResolvedValueOnce(json({ value: [message("b", { internetMessageHeaders: [] }), message("a")] }));
    const coordinate = vi.fn();
    const provider = new MicrosoftProvider("fixture", { fetchImpl, requestCoordinator: async request => { coordinate(); return request(); } });
    const first = await provider.getEnrichmentCollectionPage({ folders, pageSize: 500, pendingIds: new Set(["a", "b"]) });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1.0/me/messages"); expect(url.searchParams.get("$top")).toBe("500");
    expect(url.searchParams.get("$select")).toBe(microsoftMessageSelect.join(","));
    expect(url.searchParams.get("$select")).toContain("internetMessageHeaders");
    expect([...first.records.keys()]).toEqual(["a"]); expect(first.nextLink).toBe(cursor);
    const second = await provider.getEnrichmentCollectionPage({ folders, pageSize: first.pageSize, nextLink: first.nextLink, pendingIds: new Set(["b"]) });
    expect(String(fetchImpl.mock.calls[1][0])).toBe(cursor);
    expect([...second.records.keys()]).toEqual(["b"]); expect(second.records.get("b")?.hasListUnsubscribe).toBe(false);
    expect(second.nextLink).toBeUndefined(); expect(coordinate).toHaveBeenCalledTimes(2);
    expect(provider.getScanMetrics()).toMatchObject({ graphPages: 2, requests: 2, maxConcurrentRequests: 1 });
    expect(JSON.stringify([...first.records.values()])).not.toMatch(/Private weekly subject|private-other-header|internetMessageHeaders/);
  });

  it.each(["413", "invalid_json", "invalid_shape"])("falls back directly from 500 to 100 on %s, retaining exact committed results", async failure => {
    const failed = failure === "413" ? new Response(null, { status: 413 }) : failure === "invalid_json" ? new Response("not json") : json({ value: null });
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ value: [message("a")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next" }))
      .mockResolvedValueOnce(failed).mockResolvedValueOnce(json({ value: [message("a"), message("b")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=small" }))
      .mockResolvedValueOnce(json({ value: [message("a"), message("c")] }));
    const state = createOutlookProgressiveState([base("a"), base("b"), base("c")], new Set(), Date.UTC(2026, 9, 17));
    const step = async (nextLink?: string, pageSize: 500 | 100 = 500) => {
      // Replacing the provider simulates a new durable Workflow step.
      const provider = new MicrosoftProvider("fixture", { fetchImpl });
      const pending = new Map(state.records.flatMap((entry, index) => entry.verification === "pending" ? [[entry.record.providerMessageId, index] as const] : []));
      const page = await provider.getEnrichmentCollectionPage({ folders, pageSize, nextLink, pendingIds: new Set(pending.keys()) });
      for (const [id, record] of page.records) applyOutlookCollectionRecord(state, pending.get(id)!, record);
      return page;
    };
    const first = await step();
    const restarted = await step(first.nextLink);
    expect(restarted).toMatchObject({ pageSize: 100, fallback: true });
    expect(snapshotOutlookProgressive(state, new Set()).totals).toMatchObject({ messages: 3, cleanupCandidates: 2 });
    await step(restarted.nextLink, restarted.pageSize);
    expect(snapshotOutlookProgressive(state, new Set()).totals).toMatchObject({ messages: 3, cleanupCandidates: 3 });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("$top"))).toEqual(["500", null, "100", null]);
  });

  it("does not fall back or aggressively retry exhausted 504s, or fall below 100", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 504 }));
    const provider = new MicrosoftProvider("fixture", { fetchImpl, maxRetries: 0 });
    await expect(provider.getEnrichmentCollectionPage({ folders, pageSize: 500, pendingIds: new Set(["a"]) })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const invalid = vi.fn().mockResolvedValue(json({ value: null }));
    await expect(new MicrosoftProvider("fixture", { fetchImpl: invalid }).getEnrichmentCollectionPage({ folders, pageSize: 100, pendingIds: new Set(["a"]) })).rejects.toThrow();
    expect(invalid).toHaveBeenCalledOnce();
  });

  it("keeps malformed, missing and ambiguous duplicate candidates Review without sender evidence inference", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ value: [message("a", { internetMessageHeaders: null }),
      message("b"), message("b"), message("not-candidate")] }));
    const provider = new MicrosoftProvider("fixture", { fetchImpl });
    const state = createOutlookProgressiveState([base("a"), base("b"), base("c")], new Set(), Date.UTC(2026, 9, 17));
    const page = await provider.getEnrichmentCollectionPage({ folders, pageSize: 500, pendingIds: new Set(["a", "b", "c"]) });
    state.records.forEach((entry, index) => {
      if (page.records.has(entry.record.providerMessageId)) applyOutlookCollectionRecord(state, index, page.records.get(entry.record.providerMessageId));
      else if (!page.nextLink) applyOutlookEvidence(state, index, undefined);
    });
    expect(state.records.every(entry => entry.verification === "failed")).toBe(true);
    expect(snapshotOutlookProgressive(state, new Set()).totals).toMatchObject({ messages: 3, cleanupCandidates: 0, reviewMessages: 3 });
  });

  it.each([
    { flag: { flagStatus: "flagged" } }, { importance: "high" }, { parentFolderId: "deleted" }, { parentFolderId: "sent" },
    { parentFolderId: "draft" }, { isDraft: true }, { subject: "Your verification code" }, { receivedDateTime: "2026-10-17T00:00:00Z" },
    { conversationId: "participated" }, { parentFolderId: "unknown-folder" }
  ])("applies current Graph protections before exact message promotion: %j", async overrides => {
    const provider = new MicrosoftProvider("fixture", { fetchImpl: vi.fn().mockResolvedValue(json({ value: [message("a", overrides)] })) });
    const participated = new Set(["participated"]);
    const state = createOutlookProgressiveState([base("a"), base("b"), base("c")], participated, Date.UTC(2026, 9, 17));
    const page = await provider.getEnrichmentCollectionPage({ folders, pageSize: 500, pendingIds: new Set(["a"]) });
    applyOutlookCollectionRecord(state, 0, page.records.get("a"));
    expect(snapshotOutlookProgressive(state, participated).totals).toMatchObject({ cleanupCandidates: 0, protectedMessages: 1 });
  });
});
