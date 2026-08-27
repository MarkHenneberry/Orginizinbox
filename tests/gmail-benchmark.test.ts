import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSafeGmailFetchQuery,
  gmailConversationIndexQuery,
  gmailFetchQuery,
  gmailHeaderAllowlist,
  normalizeGmailMessage
} from "@/lib/providers/gmail/metadata";
import {
  createGoogleAuthorizationUrl,
  gmailRequiredImapScope,
  hasRequiredGmailImapScope,
  requestedGoogleOAuthScopes
} from "@/lib/providers/gmail/scopes";

describe("gmail metadata allowlist", () => {
  it("requests Subject in the bounded header set without bodies, envelope, source, or attachments", () => {
    expect(() => assertSafeGmailFetchQuery(gmailFetchQuery)).not.toThrow();
    expect(gmailFetchQuery.labels).toBe(true);
    expect(JSON.stringify(gmailFetchQuery)).not.toMatch(/bodyParts|bodyStructure|envelope|source|attachment/i);
    expect(gmailHeaderAllowlist).toEqual(["From", "List-Id", "List-Unsubscribe", "Auto-Submitted", "Precedence", "Subject"]);
  });

  it("rejects unsafe fetch expansion", () => {
    expect(() => assertSafeGmailFetchQuery({ ...gmailFetchQuery, headers: ["Subject"] })).not.toThrow();
    expect(() => assertSafeGmailFetchQuery({ ...gmailFetchQuery, headers: ["Subject", "Reply-To"] })).toThrow(/allowlist/);
    expect(() => assertSafeGmailFetchQuery({ ...gmailFetchQuery, source: true })).toThrow(/Unsafe/);
    expect(() => assertSafeGmailFetchQuery({ ...gmailFetchQuery, bodyParts: ["1"] })).toThrow(/Unsafe/);
  });

  it("normalizes only allowlisted Gmail fields", () => {
    const record = normalizeGmailMessage({
      uid: 42,
      headers: Buffer.from("From: Example <deals@example.test>\r\nSubject: General update\r\nList-Id: <offers.example>\r\nList-Unsubscribe: <mailto:off@example.test>\r\nAuto-Submitted: auto-generated\r\nPrecedence: list\r\n"),
      internalDate: new Date("2025-01-01T00:00:00Z"),
      flags: new Set(["\\Seen"]),
      labels: new Set(["CATEGORY_PROMOTIONS", "\\Sent", "Projects"]),
      size: 2048,
      threadId: "thread-1"
    });

    expect(record.senderAddress).toBe("deals@example.test");
    expect(record.hasListUnsubscribe).toBe(true);
    expect(record.listId).toBe("<offers.example>");
    expect(record.autoSubmitted).toBe("auto-generated");
    expect(record.precedence).toBe("list");
    expect(record.providerCategory).toBeUndefined();
    expect(record.isSent).toBe(true);
    expect(record.userLabels).toEqual(["Projects"]);
    expect(record.conversationId).toBe("thread-1");
    expect(record.subjectProtection).toBeUndefined();
    expect(JSON.stringify(record)).not.toMatch(/General update|rawSubject|body|attachment/i);
  });

  it("uses the installed ImapFlow Gmail thread id field for the Sent index", () => {
    const imapflowTools = readFileSync("node_modules/imapflow/lib/tools.js", "utf8");
    expect(gmailConversationIndexQuery).toEqual({ threadId: true });
    expect(imapflowTools).toMatch(/map\.threadId/);
    expect(imapflowTools).toMatch(/X-GM-THRID|x-gm-thrid/i);
  });
});

describe("gmail live benchmark guardrails", () => {
  it("generates a Google authorization URL with explicit Gmail IMAP scope", () => {
    const authorizationUrl = createGoogleAuthorizationUrl({
      clientId: "client-id",
      redirectUri: "http://localhost:3000/api/oauth/google/callback",
      state: "state-value"
    });
    const scope = authorizationUrl.searchParams.get("scope") ?? "";

    expect(requestedGoogleOAuthScopes).toEqual(["openid", "email", "profile", gmailRequiredImapScope]);
    expect(scope.split(" ")).toEqual(expect.arrayContaining(["openid", "email", "profile", gmailRequiredImapScope]));
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizationUrl.searchParams.get("include_granted_scopes")).toBeNull();
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/google/callback");
    expect(authorizationUrl.searchParams.get("state")).toBe("state-value");
  });

  it("requires the granted Google token scope to include Gmail IMAP", () => {
    expect(hasRequiredGmailImapScope(`email profile openid ${gmailRequiredImapScope}`)).toBe(true);
    expect(hasRequiredGmailImapScope("email profile https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email openid")).toBe(false);
  });

  it("opens Gmail IMAP read-only and disables mutation in this pass", () => {
    const provider = readFileSync("src/lib/providers/gmail/provider.ts", "utf8");
    expect(provider).toMatch(/mailboxOpen\(mailboxPath,\s*\{\s*readOnly:\s*true\s*\}\)/);
    expect(provider).toMatch(/mailbox\.readOnly !== true/);
    expect(provider).toMatch(/scanParticipatedConversationIds/);
    expect(provider).not.toMatch(/messageDelete|mailboxDelete|expunge|append\(/i);
  });

  it("does not serialize mailbox path, tokens, or report content in benchmark progress", () => {
    const store = readFileSync("src/lib/server/live-scan-store.ts", "utf8");
    const serializer = store.slice(store.indexOf("export function serializeBenchmark"));
    expect(serializer).not.toMatch(/mailboxPath|encrypted|accessToken|refreshToken|report/);
  });

  it("gates the report route when fixture mode is disabled", () => {
    const resolver = readFileSync("src/lib/server/report-state.ts", "utf8");
    expect(resolver).toMatch(/runtimeConfig\.fixtureMode/);
    expect(resolver).toMatch(/redirect\("\/app"\)/);
  });

  it("validates OAuth state before token exchange in the callback", () => {
    const callback = readFileSync("app/api/oauth/google/callback/route.ts", "utf8");
    expect(callback).toMatch(/stateResult = await consumeOAuthState[\s\S]+tokens = await exchangeGoogleCode/);
    expect(callback).toMatch(/GmailImapScopeNotGrantedError/);
    expect(callback).toMatch(/connect\/google\/error/);
  });

  it("checks Gmail readiness before starting a benchmark job", () => {
    const startRoute = readFileSync("app/api/dev/gmail-benchmark/start/route.ts", "utf8");
    expect(startRoute).toMatch(/getActiveGmailConnection/);
    expect(startRoute).toMatch(/const activeConnection = await getActiveGmailConnection[\s\S]+const progress = createGmailBenchmarkSession/);
  });

  it("keeps encrypted credential fields separate from mailbox-derived persistence", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/encryptedAccountEmail\s+String\?/);
    expect(schema).not.toMatch(/model\s+MessageMetadata|model\s+SenderAggregate|providerMessageId|senderKey|senderDomain|providerLabels|threadId/);
  });
});
