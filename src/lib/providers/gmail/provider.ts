import { ImapFlow, type FetchMessageObject, type ListResponse } from "imapflow";
import { env, requireGoogleOAuthConfig } from "@/lib/config";
import { indexSentConversation } from "@/lib/domain/safety";
import {
  assertSafeGmailFetchQuery,
  gmailConversationIndexQuery,
  gmailFetchQuery,
  getGmailSubjectProtection,
  normalizeGmailMessage
} from "@/lib/providers/gmail/metadata";
import { gmailRequiredImapScope } from "@/lib/providers/gmail/scopes";
import type {
  MailboxProcessor,
  MailboxProfile,
  MoveApprovedMessagesToTrashInput,
  MoveApprovedMessagesToTrashResult,
  ScanMetadataBatch,
  ScanMetadataInput,
  SearchCleanupGroupBatch,
  SearchCleanupGroupInput
} from "../types";

export const gmailScopes = {
  scan: [gmailRequiredImapScope],
  cleanup: [gmailRequiredImapScope]
};

export const gmailImapMetadataAllowlist = [
  "FROM",
  "INTERNALDATE",
  "FLAGS",
  "X-GM-LABELS",
  "RFC822.SIZE",
  "LIST-ID",
  "LIST-UNSUBSCRIBE",
  "AUTO-SUBMITTED",
  "PRECEDENCE",
  "SUBJECT",
  "X-GM-MSGID",
  "X-GM-THRID"
] as const;

export class GmailProvider implements MailboxProcessor {
  constructor(
    private readonly accessToken: string,
    private readonly userEmail: string
  ) {
    requireGoogleOAuthConfig();
  }

  async getMailboxProfile(): Promise<MailboxProfile> {
    this.assertTokenPresent();
    const client = this.createClient();
    try {
      await client.connect();
      const mailboxPath = await resolveGmailAllMail(client);
      const mailbox = await client.mailboxOpen(mailboxPath, { readOnly: true });
      return {
        provider: "gmail",
        externalAccountId: this.userEmail,
        displayName: this.userEmail,
        messageCount: mailbox.exists
      };
    } finally {
      await closeClient(client);
    }
  }

  async *scanMetadata(input: ScanMetadataInput): AsyncIterable<ScanMetadataBatch> {
    this.assertTokenPresent();
    assertSafeGmailFetchQuery(gmailFetchQuery);

    const client = this.createClient();
    try {
      throwIfAborted(input.signal);
      await client.connect();
      const mailboxPath = await resolveGmailAllMail(client);
      const mailbox = await client.mailboxOpen(mailboxPath, { readOnly: true });
      if (mailbox.readOnly !== true) {
        throw new Error("Gmail mailbox was not opened read-only.");
      }

      const mailboxExists = mailbox.exists;
      const maxMessages = input.limit === "full" || input.limit === undefined ? mailboxExists : Math.min(input.limit, mailboxExists);
      input.onConnected?.({ mailboxPath, mailboxExists, readOnly: mailbox.readOnly === true });

      for (let start = 1; start <= maxMessages; start += input.batchSize) {
        throwIfAborted(input.signal);
        const end = Math.min(start + input.batchSize - 1, maxMessages);
        const records = [];
        let subjectProtectionMs = 0;

        for await (const message of client.fetch(`${start}:${end}`, gmailFetchQuery, { uid: false })) {
          throwIfAborted(input.signal);
          const subjectProtectionStarted = performance.now();
          const subjectProtection = getGmailSubjectProtection(message.headers);
          subjectProtectionMs += performance.now() - subjectProtectionStarted;
          records.push(normalizeFetchMessage(message, subjectProtection));
        }

        yield {
          records,
          subjectProtectionMs,
          nextCursor: end < maxMessages ? String(end + 1) : undefined,
          mailboxExists
        };
      }
    } finally {
      await closeClient(client);
    }
  }

  async scanParticipatedConversationIds(input: {
    batchSize: number;
    signal?: AbortSignal;
  }): Promise<Set<string>> {
    this.assertTokenPresent();
    assertSafeGmailFetchQuery(gmailConversationIndexQuery);

    const conversationIds = new Set<string>();
    const client = this.createClient();
    try {
      throwIfAborted(input.signal);
      await client.connect();
      const mailboxPath = await resolveGmailSent(client);
      const mailbox = await client.mailboxOpen(mailboxPath, { readOnly: true });
      if (mailbox.readOnly !== true) {
        throw new Error("Gmail Sent mailbox was not opened read-only.");
      }

      for (let start = 1; start <= mailbox.exists; start += input.batchSize) {
        throwIfAborted(input.signal);
        const end = Math.min(start + input.batchSize - 1, mailbox.exists);
        for await (const message of client.fetch(`${start}:${end}`, gmailConversationIndexQuery, { uid: false })) {
          throwIfAborted(input.signal);
          indexSentConversation({ isSent: true, conversationId: message.threadId }, conversationIds);
        }
      }
      return conversationIds;
    } finally {
      await closeClient(client);
    }
  }

  async *searchCleanupGroup(_input: SearchCleanupGroupInput): AsyncIterable<SearchCleanupGroupBatch> {
    void _input;
    this.assertTokenPresent();
    throw new Error("Gmail cleanup-group search will query matching identifiers transiently after user approval. It is not implemented yet.");
  }

  async moveApprovedMessagesToTrash(_input: MoveApprovedMessagesToTrashInput): Promise<MoveApprovedMessagesToTrashResult> {
    void _input;
    this.assertTokenPresent();
    throw new Error("Gmail cleanup must move approved messages to Trash only. Live mutation is intentionally disabled in this pass.");
  }

  async disconnect(): Promise<void> {
    this.assertTokenPresent();
    throw new Error("Gmail token revocation is not implemented until OAuth persistence is enabled.");
  }

  private assertTokenPresent() {
    if (!this.accessToken) {
      throw new Error("Missing Gmail access token.");
    }
    if (!this.userEmail) {
      throw new Error("Missing Gmail account email for IMAP authentication.");
    }
  }

  private createClient() {
    return new ImapFlow({
      host: env.GMAIL_IMAP_HOST,
      port: env.GMAIL_IMAP_PORT,
      secure: true,
      logger: false,
      disableAutoIdle: true,
      auth: {
        user: this.userEmail,
        accessToken: this.accessToken
      },
      tls: {
        rejectUnauthorized: true
      }
    });
  }
}

export async function resolveGmailAllMail(client: Pick<ImapFlow, "list">): Promise<string> {
  const mailboxes = await client.list();
  const allMail = mailboxes.find(isAllMailMailbox) ?? mailboxes.find((mailbox) => mailbox.path.toLowerCase().includes("[gmail]/all mail"));
  if (!allMail) {
    throw new Error("Gmail All Mail mailbox was not found.");
  }
  return allMail.path;
}

export async function resolveGmailSent(client: Pick<ImapFlow, "list">): Promise<string> {
  const mailboxes = await client.list();
  const sent = mailboxes.find(isSentMailbox) ?? mailboxes.find((mailbox) => /\[gmail\]\/sent mail/i.test(mailbox.path));
  if (!sent) {
    throw new Error("Gmail Sent mailbox was not found.");
  }
  return sent.path;
}

function isAllMailMailbox(mailbox: ListResponse) {
  return mailbox.specialUse === "\\All" || mailbox.flags?.has("\\All") || mailbox.name.toLowerCase() === "all mail";
}

function isSentMailbox(mailbox: ListResponse) {
  return mailbox.specialUse === "\\Sent" || mailbox.flags?.has("\\Sent") || mailbox.name.toLowerCase() === "sent";
}

function normalizeFetchMessage(
  message: FetchMessageObject,
  subjectProtection: ReturnType<typeof getGmailSubjectProtection>
) {
  return normalizeGmailMessage({
    uid: message.uid,
    threadId: message.threadId,
    headers: message.headers,
    internalDate: message.internalDate instanceof Date ? message.internalDate : message.internalDate ? new Date(message.internalDate) : undefined,
    flags: message.flags,
    labels: message.labels,
    size: message.size
  }, subjectProtection);
}

async function closeClient(client: ImapFlow) {
  try {
    await client.logout();
  } catch {
    client.close();
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Gmail benchmark cancelled.", "AbortError");
  }
}
