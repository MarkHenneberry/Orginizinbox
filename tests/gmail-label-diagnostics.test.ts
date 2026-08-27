import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatGmailLabelCategoryDiagnostic } from "@/lib/domain/classifier-summary";
import { analyzeGmailLabels, normalizeGmailLabel } from "@/lib/domain/gmail-labels";
import { assessMessage } from "@/lib/domain/recommendations";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import type { NormalizedMessageMetadata } from "@/lib/domain/types";
import { normalizeGmailMessage } from "@/lib/providers/gmail/metadata";

const now = new Date("2026-08-26T12:00:00Z");

function message(overrides: Partial<NormalizedMessageMetadata> = {}): NormalizedMessageMetadata {
  return {
    providerMessageId: "private-message-id",
    provider: "gmail",
    senderAddress: "sender@example.test",
    senderDomain: "example.test",
    receivedAt: new Date("2024-01-01T00:00:00Z"),
    isRead: false,
    estimatedSize: 1000,
    ...overrides
  };
}

describe("Gmail IMAP label normalization", () => {
  it("normalizes system labels case-insensitively without turning REST-shaped labels into category input", () => {
    const record = normalizeGmailMessage({
      flags: new Set(),
      labels: new Set([
        "\\sTaRrEd",
        "IMPORTANT",
        "[Gmail]/Sent Mail",
        "[GoogleMail]/Drafts",
        "category_promotions",
        "Private Family Matter"
      ])
    });

    expect(record).toMatchObject({
      isStarred: true,
      isImportant: true,
      isSent: true,
      isDraft: true,
      userLabels: ["Private Family Matter"]
    });
    expect(record.providerCategory).toBeUndefined();
    expect(normalizeGmailLabel("  \\iMpOrTaNt ")).toBe("IMPORTANT");
  });

  it("counts known category-shaped values only as safe diagnostics", () => {
    const analysis = analyzeGmailLabels([
      "CATEGORY_PROMOTIONS",
      "category_social",
      "CATEGORY_PRIMARY",
      "category_updates",
      "\\Unknown-System-Label",
      "Private Family Matter"
    ]);

    expect([...analysis.categoryLabels]).toEqual(["PROMOTIONS", "SOCIAL", "PERSONAL", "UPDATES"]);
    expect(analysis.userLabels).toEqual(["Private Family Matter"]);
    expect(analysis.unrecognizedSystemOrCategoryShapedLabels).toBe(1);
  });
});

describe("Gmail automation header normalization", () => {
  it("parses all allowlisted headers together and handles mixed-case Auto-Submitted and Precedence values", () => {
    const record = normalizeGmailMessage({
      headers: Buffer.from(
        "From: Updates <updates@example.test>\r\n" +
          "Subject: Account receipt\r\n" +
          "List-Id: <updates.example>\r\n" +
          "List-Unsubscribe: <mailto:off@example.test>\r\n" +
          "aUtO-sUbMiTtEd: AuTo-GeNeRaTeD\r\n" +
          "pReCeDeNcE: LiSt\r\n"
      )
    });
    const assessed = assessMessage(record, { now });

    expect(record).toMatchObject({
      hasListUnsubscribe: true,
      listId: "<updates.example>",
      autoSubmitted: "auto-generated",
      precedence: "list",
      subjectProtection: "transactional"
    });
    expect(assessed.cleanupSignals).toEqual(
      expect.arrayContaining(["HAS_LIST_ID", "HAS_LIST_UNSUBSCRIBE", "AUTO_SUBMITTED", "PRECEDENCE_LIST"])
    );
  });

  it.each([
    ["BuLk", "PRECEDENCE_BULK"],
    ["LiSt", "PRECEDENCE_LIST"]
  ] as const)("treats mixed-case Precedence %s as automation evidence", (precedence, signal) => {
    const record = normalizeGmailMessage({ headers: Buffer.from(`Precedence: ${precedence}\r\n`) });
    expect(assessMessage(record, { now }).cleanupSignals).toContain(signal);
  });

  it("distinguishes Auto-Submitted header presence from an automation value", () => {
    const automated = normalizeGmailMessage({ headers: Buffer.from("Auto-Submitted: auto-replied\r\n") });
    const explicitlyNotAutomated = normalizeGmailMessage({ headers: Buffer.from("Auto-Submitted: NO\r\n") });
    const absent = normalizeGmailMessage({});

    expect(automated.autoSubmitted).toBe("auto-replied");
    expect(assessMessage(automated, { now }).cleanupSignals).toContain("AUTO_SUBMITTED");
    expect(explicitlyNotAutomated.autoSubmitted).toBe("no");
    expect(assessMessage(explicitlyNotAutomated, { now }).cleanupSignals).not.toContain("AUTO_SUBMITTED");
    expect(absent.autoSubmitted).toBeUndefined();
  });
});

describe("Gmail aggregate diagnostics", () => {
  it("reports counts without exposing user-label names or message metadata", () => {
    const aggregator = new StreamingReportAggregator({ now, includeDiagnostics: true });
    aggregator.processBatch([
      message({
        providerLabels: ["\\sTaRrEd", "Important", "CATEGORY_PROMOTIONS", "Private Family Matter"],
        autoSubmitted: "auto-generated"
      }),
      message({
        providerMessageId: "second-private-id",
        providerLabels: ["[Gmail]/Sent Mail", "[Gmail]/Drafts", "CATEGORY_SOCIAL", "\\Mystery"],
        autoSubmitted: "no"
      }),
      message({ providerMessageId: "third-private-id", providerLabels: ["Private Family Matter"] })
    ]);

    const report = aggregator.snapshot("gmail", false);
    const diagnostics = report.classifierDiagnostics!.gmailLabelCategory!;
    const output = formatGmailLabelCategoryDiagnostic(report);

    expect(diagnostics).toMatchObject({
      scanCategoryInput: "unavailable_through_imap_labels",
      messagesWithAnyGmailLabels: 3,
      normalizedSystemLabelMessages: { starred: 1, important: 1, sent: 1, draft: 1 },
      observedImapCategoryLabelMessages: { promotions: 1, social: 1, personal: 0, updates: 0 },
      observedProviderCategoryMessages: { promotions: 0, social: 0, personal: 0, updates: 0 },
      messagesWithUserLabels: 2,
      distinctUserLabelsObserved: 1,
      unrecognizedSystemOrCategoryShapedLabels: 1,
      autoSubmittedHeaderPresentMessages: 2,
      autoSubmittedAutomationMessages: 1
    });
    expect(output).toContain("Scan-time category input: unavailable through the current X-GM-LABELS fetch");
    expect(output).toContain("PROMOTIONS: unavailable");
    expect(output).toContain("PERSONAL/PRIMARY: unavailable");
    expect(output).not.toMatch(/Private Family Matter|private-message-id|second-private-id|third-private-id|auto-generated/);
  });

  it("does not add logging to label analysis or diagnostic aggregation", () => {
    const source = [
      readFileSync("src/lib/domain/gmail-labels.ts", "utf8"),
      readFileSync("src/lib/domain/streaming-aggregator.ts", "utf8")
    ].join("\n");

    expect(source).not.toMatch(/console\.|logger\.|log\.(?:debug|info|warn|error)/);
  });
});
