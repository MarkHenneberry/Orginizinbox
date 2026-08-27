import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatMailboxClassifierSummary,
  formatSenderClassifierSummary
} from "@/lib/domain/classifier-summary";
import { assessMessage } from "@/lib/domain/recommendations";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import { deriveSubjectProtection } from "@/lib/domain/subject-protection";
import type { NormalizedMessageMetadata } from "@/lib/domain/types";
import { gmailFetchQuery, normalizeGmailMessage } from "@/lib/providers/gmail/metadata";

const now = new Date("2026-08-25T12:00:00Z");

function message(overrides: Partial<NormalizedMessageMetadata> = {}): NormalizedMessageMetadata {
  return {
    providerMessageId: "message-1",
    provider: "gmail",
    senderAddress: "announce@example.test",
    senderDisplayName: "Example",
    senderDomain: "example.test",
    receivedAt: new Date("2024-01-01T00:00:00Z"),
    isRead: false,
    estimatedSize: 1000,
    hasListUnsubscribe: true,
    ...overrides
  };
}

function normalizedFromSubject(subject: string) {
  return normalizeGmailMessage({
    uid: 42,
    headers: Buffer.from(
      `From: Runway <announce@example.test>\r\nList-Unsubscribe: <mailto:off@example.test>\r\nSubject: ${subject}\r\n`
    ),
    internalDate: new Date("2024-01-01T00:00:00Z")
  });
}

describe("deterministic Subject protection matching", () => {
  it.each([
    ["Your receipt from Runway AI, Inc. #2429-0529", "transactional"],
    ["Invoice #48391 is ready", "transactional"],
    ["Booking confirmation for Halifax", "transactional"],
    ["Reservation details for your stay", "transactional"],
    ["Fiverr: Your account was disabled.", "security_account"],
    ["Security Alert: New sign-in", "security_account"],
    ["PASSWORD RESET REQUEST", "security_account"]
  ] as const)("protects %s", (subject, expected) => {
    expect(deriveSubjectProtection(subject)).toBe(expected);
  });

  it("decodes MIME-encoded Subjects before matching", () => {
    const encoded = `=?UTF-8?B?${Buffer.from("Your receipt from Runway AI, Inc.").toString("base64")}?=`;
    expect(deriveSubjectProtection(encoded)).toBe("transactional");
    expect(normalizedFromSubject(encoded).subjectProtection).toBe("transactional");
  });

  it("fails safely for malformed encoded Subjects", () => {
    expect(deriveSubjectProtection("=?UTF-8?Q?receipt")).toBeUndefined();
    expect(normalizedFromSubject("=?UTF-8?Q?receipt").subjectProtection).toBeUndefined();
  });

  it.each(["Sale ends tonight", "Weekly newsletter", "50% discount offer", "General product update"])(
    "does not turn promotional copy into cleanup evidence: %s",
    (subject) => {
      expect(deriveSubjectProtection(subject)).toBeUndefined();
      const assessed = assessMessage(
        message({ hasListUnsubscribe: false, subjectProtection: deriveSubjectProtection(subject) }),
        { now }
      );
      expect(assessed.eligibleForCleanup).toBe(false);
      expect(assessed.cleanupSignals).not.toEqual(
        expect.arrayContaining(["HAS_LIST_ID", "HAS_LIST_UNSUBSCRIBE", "CATEGORY_PROMOTIONS"])
      );
    }
  );
});

describe("Subject as a one-way hard protection", () => {
  it("does not let promotional Subject text raise sender recommendation confidence", () => {
    const aggregate = (subject: string) => {
      const aggregator = new StreamingReportAggregator({ now });
      aggregator.processBatch(
        Array.from({ length: 30 }, (_, index) =>
          message({
            providerMessageId: `message-${index}`,
            hasListUnsubscribe: false,
            subjectProtection: deriveSubjectProtection(subject)
          })
        )
      );
      return aggregator.snapshot("gmail", false).senders[0];
    };

    const baseline = aggregate("General product update");
    for (const promotionalSubject of ["Sale ends tonight", "Weekly newsletter", "50% discount offer"]) {
      const sender = aggregate(promotionalSubject);
      expect(sender.cleanupConfidence).toBe(baseline.cleanupConfidence);
      expect(sender.cleanupCandidateCount).toBe(baseline.cleanupCandidateCount);
    }
  });

  it("protects Runway-style List-Unsubscribe mail with a receipt Subject", () => {
    const assessed = assessMessage(normalizedFromSubject("Your receipt from Runway AI, Inc. #2429-0529"), { now });

    expect(assessed.cleanupSignals).toContain("HAS_LIST_UNSUBSCRIBE");
    expect(assessed.protectionReasons).toContain("PROTECTED_TRANSACTIONAL_SUBJECT");
    expect(assessed.eligibleForCleanup).toBe(false);
  });

  it("leaves ordinary List-Unsubscribe mail eligible under the existing rules", () => {
    const assessed = assessMessage(normalizedFromSubject("Product updates for August"), { now });
    expect(assessed.protectionReasons).not.toEqual(
      expect.arrayContaining(["PROTECTED_TRANSACTIONAL_SUBJECT", "PROTECTED_SECURITY_ACCOUNT_SUBJECT"])
    );
    expect(assessed.eligibleForCleanup).toBe(true);
  });

  it("keeps a Subject-protected message out of a Very High sender's Ready subset", () => {
    const aggregator = new StreamingReportAggregator({ now, includeDiagnostics: true });
    aggregator.processBatch(
      Array.from({ length: 30 }, (_, index) =>
        message({
          providerMessageId: `message-${index}`,
          listId: "offers.example",
          subjectProtection: index === 0 ? "transactional" : undefined
        })
      )
    );
    const sender = aggregator.snapshot("gmail", false).senders[0];

    expect(sender.cleanupConfidence).toBe("very_high");
    expect(sender.cleanupCandidateCount).toBe(29);
    expect(sender.protectedMessages).toBe(1);
    expect(sender.protectionReasons).toContain("PROTECTED_TRANSACTIONAL_SUBJECT");
    expect(sender.diagnostics?.messageSignals.transactionalSubjectMessages).toBe(1);
  });
});

describe("Subject privacy boundary", () => {
  it("discards raw Subject text after deriving the typed signal", () => {
    const record = normalizedFromSubject("Your receipt from Runway AI, Inc. #2429-0529");
    const aggregator = new StreamingReportAggregator({ now, includeDiagnostics: true });
    aggregator.process(record);
    const report = aggregator.snapshot("gmail", false);
    const serialized = JSON.stringify({ record, report });
    const summaries = [
      formatMailboxClassifierSummary(report),
      formatSenderClassifierSummary(report.senders[0])
    ].join("\n");

    expect(serialized).toContain("transactional");
    expect(serialized).not.toContain("Your receipt from Runway");
    expect(serialized).not.toMatch(/rawSubject|subjectText/);
    expect(summaries).toContain("Subject protection: 1");
    expect(summaries).not.toContain("Your receipt from Runway");
  });

  it("does not add raw Subject persistence, logging, analytics, body, snippet, or attachment access", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const subjectModule = readFileSync("src/lib/domain/subject-protection.ts", "utf8");
    const apiClient = readFileSync("src/lib/providers/gmail/gmail-api-client.ts", "utf8");

    expect(schema).not.toMatch(/subject/i);
    expect(subjectModule).not.toMatch(/console\.|analytics|fetch\(/);
    expect(JSON.stringify(gmailFetchQuery)).not.toMatch(/bodyParts|bodyStructure|source|envelope|attachment|snippet/i);
    expect(apiClient).not.toMatch(/snippet|bodyParts|attachment/i);
  });
});
