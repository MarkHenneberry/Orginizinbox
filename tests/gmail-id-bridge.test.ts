import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  gmailApiHexIdToImapDecimal,
  gmailImapDecimalIdToApiHex,
  verifyGmailIdBridge
} from "@/lib/providers/gmail/id-bridge";

describe("Gmail X-GM-MSGID bridge", () => {
  it("converts unsigned 64-bit decimal IDs to API hexadecimal without Number precision loss", () => {
    expect(gmailImapDecimalIdToApiHex("1278455344230334865")).toBe("11bdfc5cae0c8191");
    expect(gmailImapDecimalIdToApiHex("18446744073709551615")).toBe("ffffffffffffffff");
    expect(gmailApiHexIdToImapDecimal("FFFFFFFFFFFFFFFF")).toBe("18446744073709551615");
  });

  it("normalizes harmless leading zeros", () => {
    expect(gmailImapDecimalIdToApiHex("00015")).toBe("f");
    expect(gmailApiHexIdToImapDecimal("000f")).toBe("15");
  });

  it.each(["", "-1", "+1", "1.5", " 1", "18446744073709551616"])("rejects invalid decimal ID %j", (value) => {
    expect(() => gmailImapDecimalIdToApiHex(value)).toThrow();
  });

  it.each(["", "-1", "0x10", "xyz", "10000000000000000"])("rejects invalid hexadecimal ID %j", (value) => {
    expect(() => gmailApiHexIdToImapDecimal(value)).toThrow();
  });

  it("requires exact ID, sender, and shared labels while treating internal date as supplemental", () => {
    const evidence = {
      imapMessageId: "1278455344230334865",
      apiMessageId: "11bdfc5cae0c8191",
      imapSender: "Sender <sender@example.com>",
      apiSender: "Sender <sender@example.com>",
      imapInternalDateMs: 1_700_000_000_000,
      apiInternalDateMs: 1_700_000_000_000,
      imapLabels: ["\\Inbox", "\\Important"],
      apiLabelIds: ["INBOX", "IMPORTANT", "UNREAD"]
    };
    expect(verifyGmailIdBridge(evidence)).toBe(true);
    expect(verifyGmailIdBridge({ ...evidence, apiMessageId: "11bdfc5cae0c8192" })).toBe(false);
    expect(verifyGmailIdBridge({ ...evidence, apiSender: "other@example.com" })).toBe(false);
    expect(verifyGmailIdBridge({ ...evidence, imapSender: undefined, apiSender: undefined })).toBe(false);
    expect(verifyGmailIdBridge({ ...evidence, apiInternalDateMs: 1_700_000_000_999 })).toBe(true);
    expect(verifyGmailIdBridge({ ...evidence, apiInternalDateMs: 1_700_000_001_000 })).toBe(true);
    expect(verifyGmailIdBridge({ ...evidence, apiLabelIds: ["INBOX"] })).toBe(false);
  });

  it("uses explicit Gmail-extension provenance instead of trusting generic emailId", () => {
    const fetchCompiler = readFileSync("node_modules/imapflow/lib/commands/fetch.js", "utf8");
    const responseParser = readFileSync("node_modules/imapflow/lib/tools.js", "utf8");
    const proof = readFileSync("scripts/prove-gmail-id-bridge.mjs", "utf8");

    expect(fetchCompiler).toMatch(/capabilities\.has\('X-GM-EXT-1'\)[\s\S]+value: 'X-GM-MSGID'/);
    expect(responseParser).toMatch(/case 'x-gm-msgid'[\s\S]+map\.emailId = getString\(attribute\)/);
    expect(proof).toMatch(/capabilities\.has\("X-GM-EXT-1"\)/);
    expect(proof).toMatch(/capabilities\.has\("OBJECTID"\)/);
    expect(proof).toMatch(/!hasGmailExtension \|\| hasObjectId/);
  });

  it("keeps proof identifiers out of persistence, client state, and output", () => {
    const proof = readFileSync("scripts/prove-gmail-id-bridge.mjs", "utf8");
    expect(proof.match(/prisma\.[a-zA-Z0-9_$.]+/g)).toEqual([
      "prisma.providerConnection.findFirst",
      "prisma.$disconnect"
    ]);
    expect(proof).not.toMatch(/localStorage|sessionStorage|console\.log/);
    expect(proof).not.toMatch(/`(ID|Message ID):\s*\$\{/);
  });
});
