import { EventEmitter } from "node:events";
import type { FetchMessageObject, FetchQueryObject, ImapFlow, ListResponse } from "imapflow";
import { describe, expect, it } from "vitest";
import { assessMessage } from "@/lib/domain/recommendations";
import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import {
  OutlookImapProvider,
  outlookImapBatchSize,
  outlookImapFetchQuery,
  outlookImapHeaderAllowlist,
  outlookImapParticipationFetchQuery
} from "@/lib/providers/microsoft/imap-provider";

describe("Outlook IMAP read-only benchmark", () => {
  it("fetches allowlisted headers in batches and preserves Outlook safety evidence", async () => {
    const threadIndex = Buffer.alloc(22, 7).toString("base64");
    const client = new FakeImapClient(defaultFolders(), new Map([
      ["Sent", [message(1, {
        from: "Me <me@example.test>",
        messageId: "<sent-root@example.test>",
        threadIndex
      })]],
      ["Inbox", [
        message(2, {
          from: "Participated List <participated@example.test>",
          references: "<sent-root@example.test>",
          listId: "participated.example.test",
          listUnsubscribe: "<https://example.test/unsubscribe>"
        }),
        message(3, {
          from: "Flagged List <flagged@example.test>",
          flags: ["\\Flagged"],
          listId: "flagged.example.test"
        }),
        message(4, {
          from: "Categorized List <category@example.test>",
          flags: ["CategoryBlue"],
          listId: "category.example.test"
        }),
        message(5, {
          from: "Receipt Service <receipt@example.test>",
          subject: "Your payment receipt",
          listId: "receipt.example.test"
        }),
        message(6, {
          from: "Newsletter <newsletter@example.test>",
          listId: "newsletter.example.test",
          listUnsubscribe: "<mailto:unsubscribe@example.test>",
          precedence: "bulk",
          importance: "high"
        })
      ]],
      ["Drafts", [message(7, { from: "Draft <draft@example.test>", listId: "draft.example.test" })]],
      ["Deleted Items/Archive", [message(8, { from: "Deleted <deleted@example.test>", listId: "deleted.example.test" })]]
    ]));
    const provider = new OutlookImapProvider("access-token", "me@example.test", {
      clientFactory: () => client as unknown as ImapFlow
    });

    const participated = await provider.scanParticipatedConversationIds({ batchSize: outlookImapBatchSize });
    const records = [];
    for await (const batch of provider.scanMetadata({ limit: "full", batchSize: outlookImapBatchSize })) {
      records.push(...batch.records);
    }
    await provider.close();

    expect(client.openCalls.every((call) => call.readOnly === true)).toBe(true);
    expect(client.fetchCalls.every((call) => call.uid === false)).toBe(true);
    expect(client.fetchCalls[0]?.query).toBe(outlookImapParticipationFetchQuery);
    expect(client.fetchCalls.slice(1).every((call) => call.query === outlookImapFetchQuery)).toBe(true);
    expect(outlookImapHeaderAllowlist).toEqual([
      "From", "Subject", "List-Id", "List-Unsubscribe", "Auto-Submitted", "Precedence",
      "Importance", "X-Priority", "Thread-Index", "Message-ID", "References", "In-Reply-To"
    ]);
    expect(outlookImapFetchQuery).not.toHaveProperty("source");
    expect(outlookImapFetchQuery).not.toHaveProperty("bodyParts");
    expect(outlookImapFetchQuery).not.toHaveProperty("envelope");
    expect(outlookImapParticipationFetchQuery).toEqual({
      headers: ["Thread-Index", "Message-ID", "References", "In-Reply-To"]
    });

    const bySender = new Map(records.map((record) => [record.senderAddress, record]));
    expect(assessMessage(bySender.get("participated@example.test")!, { participatedConversationIds: participated }).protectionReasons)
      .toContain("PROTECTED_USER_PARTICIPATED_CONVERSATION");
    expect(assessMessage(bySender.get("flagged@example.test")!).protectionReasons).toContain("PROTECTED_STARRED");
    expect(assessMessage(bySender.get("draft@example.test")!).protectionReasons).toContain("PROTECTED_DRAFT");
    expect(assessMessage(bySender.get("deleted@example.test")!).protectionReasons).toContain("PROTECTED_MAILBOX_LOCATION");
    expect(assessMessage(bySender.get("receipt@example.test")!).protectionReasons).toContain("PROTECTED_TRANSACTIONAL_SUBJECT");
    expect(assessMessage(bySender.get("category@example.test")!).reviewSignals).toContain("USER_LABEL_PRESENT");
    expect(assessMessage(bySender.get("newsletter@example.test")!).protectionReasons).toContain("PROTECTED_IMPORTANT");

    const aggregator = new StreamingReportAggregator({ participatedConversationIds: participated, includeDiagnostics: true });
    aggregator.processBatch(records);
    const report = aggregator.snapshot("microsoft", false);
    expect(report.classifierDiagnostics?.readyStrongSignals.withHardProtectionMessages).toBe(0);
    expect(report.classifierDiagnostics?.readyStrongSignals.withoutStrongSignalMessages).toBe(0);
    expect(provider.getScanMetrics()).toMatchObject({
      folders: 5,
      retries: 0,
      errors: 0,
      evidenceAvailability: {
        conversationIdentity: true,
        importance: true,
        categories: false,
        listId: true,
        listUnsubscribe: true,
        autoSubmitted: true,
        precedence: true
      }
    });
    expect(records[0]?.providerMessageId).not.toMatch(/Sent|Inbox|\b[1-8]\b/);
    expect(JSON.stringify(records)).not.toContain("sent-root@example.test");
    expect(JSON.stringify(records)).not.toContain("Your payment receipt");
  });

  it("uses 250-message sequence batches without one-message fetches", async () => {
    const inbox = Array.from({ length: 251 }, (_, index) => message(index + 1, {
      from: `List ${index} <list-${index}@example.test>`,
      listId: "newsletter.example.test"
    }));
    const client = new FakeImapClient(defaultFolders(), new Map([["Inbox", inbox]]));
    const provider = new OutlookImapProvider("access-token", "me@example.test", {
      clientFactory: () => client as unknown as ImapFlow
    });

    await provider.scanParticipatedConversationIds({ batchSize: outlookImapBatchSize });
    const sizes = [];
    for await (const batch of provider.scanMetadata({ limit: "full", batchSize: outlookImapBatchSize })) {
      sizes.push(batch.records.length);
    }

    expect(sizes).toEqual([250, 1]);
    expect(client.fetchCalls.map((call) => call.range)).toEqual(["1:250", "251:251"]);
    expect(provider.getScanMetrics().metadataBatches).toBe(2);
  });

  it("fails closed when protected Outlook system folders are not identified", async () => {
    const client = new FakeImapClient([folder("Inbox")], new Map());
    const provider = new OutlookImapProvider("access-token", "me@example.test", {
      clientFactory: () => client as unknown as ImapFlow
    });

    await expect(provider.scanParticipatedConversationIds({ batchSize: outlookImapBatchSize }))
      .rejects.toThrow("protected system folders");
  });
});

type MessageOptions = {
  from: string;
  subject?: string;
  flags?: string[];
  listId?: string;
  listUnsubscribe?: string;
  autoSubmitted?: string;
  precedence?: string;
  importance?: string;
  threadIndex?: string;
  messageId?: string;
  references?: string;
};

function message(uid: number, options: MessageOptions): FetchMessageObject {
  const values = [
    ["From", options.from],
    ["Subject", options.subject],
    ["List-Id", options.listId],
    ["List-Unsubscribe", options.listUnsubscribe],
    ["Auto-Submitted", options.autoSubmitted],
    ["Precedence", options.precedence],
    ["Importance", options.importance],
    ["Thread-Index", options.threadIndex],
    ["Message-ID", options.messageId],
    ["References", options.references]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return {
    seq: uid,
    uid,
    internalDate: new Date("2020-01-01T00:00:00Z"),
    flags: new Set(options.flags ?? []),
    headers: Buffer.from(values.map(([name, value]) => `${name}: ${value}`).join("\r\n") + "\r\n\r\n")
  } as FetchMessageObject;
}

function defaultFolders() {
  return [
    folder("Inbox"),
    folder("Sent", "\\Sent"),
    folder("Drafts", "\\Drafts"),
    folder("Deleted Items", "\\Trash"),
    folder("Deleted Items/Archive")
  ];
}

function folder(path: string, specialUse?: string): ListResponse {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    delimiter: "/",
    flags: new Set(specialUse ? [specialUse] : []),
    specialUse
  } as ListResponse;
}

class FakeImapClient extends EventEmitter {
  readonly openCalls: Array<{ path: string; readOnly: boolean }> = [];
  readonly fetchCalls: Array<{ range: string; query: FetchQueryObject; uid: boolean }> = [];
  private currentPath = "";

  constructor(
    private readonly folders: ListResponse[],
    private readonly messages: Map<string, FetchMessageObject[]>
  ) {
    super();
  }

  async connect() {
    this.command("A1 CAPABILITY");
  }

  async list() {
    this.command("A2 LIST");
    return this.folders;
  }

  async mailboxOpen(path: string, options: { readOnly?: boolean }) {
    this.command("A3 EXAMINE");
    this.currentPath = path;
    this.openCalls.push({ path, readOnly: options.readOnly === true });
    return {
      path,
      exists: this.messages.get(path)?.length ?? 0,
      uidValidity: 123n,
      readOnly: options.readOnly === true
    };
  }

  async *fetch(range: string, query: FetchQueryObject, options: { uid?: boolean }) {
    this.command("A4 FETCH");
    this.fetchCalls.push({ range, query, uid: options.uid === true });
    const [start, end] = range.split(":").map(Number);
    for (const item of (this.messages.get(this.currentPath) ?? []).slice(start - 1, end)) yield item;
  }

  async logout() {
    this.command("A5 LOGOUT");
  }

  close() {}

  private command(msg: string) {
    this.emit("log", { src: "c", msg });
  }
}
