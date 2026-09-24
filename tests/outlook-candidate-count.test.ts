import { describe, expect, it, vi } from "vitest";
import { estimateOutlookCandidatePayload, isOutlookHeaderCandidate, runOutlookCandidateCount } from "@/lib/server/outlook-candidate-count";
import type { NormalizedMailboxRecord } from "@/lib/domain/types";

const now = new Date("2026-09-24T12:00:00Z");
const record: NormalizedMailboxRecord = { provider: "microsoft", providerMessageId: "private-id", senderAddress: "person@example.test",
  receivedAt: new Date("2020-01-01"), isRead: false };

describe("aggregate Outlook candidate counter", () => {
  it.each([
    { isStarred: true }, { isImportant: true }, { isSent: true }, { isDraft: true },
    { isExcludedMailboxLocation: true }, { hasUncertainMetadata: true },
    { subjectProtection: "transactional" }, { subjectProtection: "security_account" },
    { providerCategory: "personal" }, { conversationId: "participated" },
    { receivedAt: new Date("2026-09-23") }, { receivedAt: new Date("2026-07-01") }
  ] as Partial<NormalizedMailboxRecord>[])("excludes non-header protection/age %j", (override) => {
    expect(isOutlookHeaderCandidate({ ...record, ...override }, new Set(["participated"]), now)).toBe(false);
  });
  it("counts unknown old mail as plausible without assuming bulk evidence", () => {
    expect(isOutlookHeaderCandidate(record, new Set(), now)).toBe(true);
    expect(isOutlookHeaderCandidate({ ...record, listId: "ignored" }, new Set(), now)).toBe(true);
    expect(estimateOutlookCandidatePayload(10015, 0).estimatedBaseOnlyBytes).toBe(7344120);
    expect(estimateOutlookCandidatePayload(10015, 10015).estimatedReductionPercentage).toBe(0);
  });

  it.each([false, true])("uses the real base normalization and safety pipeline, failure=%s", async (fail) => {
    let mainPages = 0;
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, options?: RequestInit) => {
      expect(options?.method).toBe("GET");
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("$select") ?? "").not.toContain("internetMessageHeaders");
      const folder = parsed.pathname.match(/\/mailFolders\/(inbox|sentitems|drafts|deleteditems)$/)?.[1];
      if (folder) return Response.json({ id: folder, childFolderCount: 0, totalItemCount: 4 });
      if (parsed.pathname === "/v1.0/me/mailFolders") return Response.json({ value: [] });
      if (parsed.pathname === "/v1.0/me/mailFolders/sentitems/messages") return Response.json({ value: [{ conversationId: "participated" }] });
      if (parsed.pathname === "/v1.0/me/messages") {
        mainPages++;
        if (mainPages === 2) {
          if (fail) return new Response("PRIVATE RESPONSE", { status: 403 });
          return Response.json({ value: [] });
        }
        expect(parsed.searchParams.get("$top")).toBe("100");
        const base = { from: { emailAddress: { address: "private@example.test" } }, receivedDateTime: "2020-01-01T00:00:00Z",
          isRead: true, importance: "normal", flag: { flagStatus: "notFlagged" }, parentFolderId: "inbox", isDraft: false };
        return Response.json({ value: [
          { ...base, id: "a", subject: "Ordinary update" },
          { ...base, id: "b", conversationId: "participated" },
          { ...base, id: "c", parentFolderId: "deleteditems" },
          { ...base, id: "d", flag: { flagStatus: "flagged" } }
        ], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=private-cursor" });
      }
      throw new Error("Unexpected fixture route");
    });
    const result = await runOutlookCandidateCount({ accessToken: "private-token", now,
      signal: new AbortController().signal, coordinate: (request) => request(), fetchImpl: fetchImpl as typeof fetch });
    expect(result).toMatchObject({ complete: !fail, totalMessagesScanned: 4, stage2Candidates: 1, candidatePercentage: 25 });
    if (fail) expect(result.payloadEstimates).toBeNull();
    else expect(result.payloadEstimates).toEqual(estimateOutlookCandidatePayload(4, 1));
    expect(JSON.stringify(result)).not.toMatch(/private|subject|sender|nextLink|https|token|report/i);
  });
});
