import { describe, expect, it } from "vitest";
import {
  assertMatchingUidValidity,
  collectCompleteGmailList,
  compareImapAndRestMutableState,
  evaluateExactImapRecheck,
  mutableStateFromImap,
  mutableStateFromRest
} from "@/lib/providers/gmail/scale-safety";

describe("scalable Gmail safety primitives", () => {
  it("follows complete pagination without deriving pages from target count", async () => {
    const tokens: Array<string | undefined> = [];
    const pages = [
      { ids: Array.from({ length: 500 }, (_, index) => `a-${index}`), nextPageToken: "two" },
      { ids: Array.from({ length: 500 }, (_, index) => `b-${index}`), nextPageToken: "three" },
      { ids: ["last"] }
    ];
    const result = await collectCompleteGmailList(async (token) => {
      tokens.push(token);
      return pages[tokens.length - 1];
    });
    expect(tokens).toEqual([undefined, "two", "three"]);
    expect(result).toMatchObject({ requests: 3, pages: 3, resultIdsReturned: 1_001 });
  });

  it.each([100, 500, 1_000])("uses real returned pages for %i targets", async (targetCount) => {
    const result = await collectCompleteGmailList(async (token) => {
      if (!token) return { ids: ["first"], nextPageToken: "second" };
      if (token === "second") return { ids: ["second"], nextPageToken: "third" };
      return { ids: ["third"] };
    });
    expect(result.pages).toBe(3);
    expect(result.pages).not.toBe(Math.ceil(targetCount / 500));
  });

  it("requires matching UIDVALIDITY", () => {
    expect(() => assertMatchingUidValidity(42n, 42n)).not.toThrow();
    expect(() => assertMatchingUidValidity(42n, 43n)).toThrow(/UIDVALIDITY/);
  });

  it("fetches only exact UIDs and excludes missing or identity-mismatched messages without substitution", () => {
    const result = evaluateExactImapRecheck(
      [
        { uid: 1, apiMessageId: "f" },
        { uid: 2, apiMessageId: "10" },
        { uid: 3, apiMessageId: "11" },
        { uid: 4, apiMessageId: "12" }
      ],
      [
        { uid: 1, emailId: "15", flags: new Set(), labels: [] },
        { uid: 2, emailId: "999", flags: new Set(), labels: [] },
        { uid: 4, emailId: "18", flags: new Set(["\\Flagged"]), labels: [] },
        { uid: 99, emailId: "19", flags: new Set(), labels: [] }
      ]
    );
    expect(result.eligibleIds).toEqual(["f"]);
    expect(result.excludedMissingCount).toBe(1);
    expect(result.excludedIdentityMismatchCount).toBe(1);
    expect(result.statesById.has("12")).toBe(true);
    expect(result.statesById.has("13")).toBe(false);
  });

  it("recognizes Starred, Important, Trash, Sent, and Draft from exact IMAP state", () => {
    expect(mutableStateFromImap(new Set(["\\Flagged", "\\Draft"]), ["\\Important", "\\Trash", "\\Sent"]))
      .toMatchObject({ starred: true, important: true, trash: true, sent: true, draft: true, personal: false });
  });

  it("preserves Personal as REST-only state", () => {
    expect(mutableStateFromRest(["CATEGORY_PERSONAL"])).toMatchObject({ personal: true });
    expect(mutableStateFromImap(new Set(), ["CATEGORY_PERSONAL"])).toMatchObject({ personal: false });
  });

  it("compares exact shared mutable state and reports mismatch or unavailable safely", () => {
    const base = mutableStateFromRest([]);
    const imap = new Map([
      ["a", base],
      ["b", { ...base, starred: true }]
    ]);
    const rest = new Map([
      ["a", base],
      ["b", base]
    ]);
    expect(compareImapAndRestMutableState(imap, rest, ["a", "b", "c"]))
      .toEqual({ compared: 3, stateMatches: 1, mismatches: 1, unavailable: 1 });
  });
});
