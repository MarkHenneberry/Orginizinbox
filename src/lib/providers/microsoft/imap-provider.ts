import { createHash } from "node:crypto";
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type ListResponse } from "imapflow";
import { deriveSubjectProtection } from "@/lib/domain/subject-protection";
import type { NormalizedMailboxRecord } from "@/lib/domain/types";
import { env } from "@/lib/config";
import { parseHeaderValue, parseSender } from "@/lib/providers/gmail/metadata";
import type { ScanMetadataBatch, ScanMetadataInput } from "@/lib/providers/types";

export const outlookImapBatchSize = 250;
export const outlookImapHeaderAllowlist = [
  "From",
  "Subject",
  "List-Id",
  "List-Unsubscribe",
  "Auto-Submitted",
  "Precedence",
  "Importance",
  "X-Priority",
  "Thread-Index",
  "Message-ID",
  "References",
  "In-Reply-To"
] as const;

export const outlookImapFetchQuery: FetchQueryObject = {
  uid: true,
  internalDate: true,
  flags: true,
  headers: [...outlookImapHeaderAllowlist]
};

export const outlookImapParticipationFetchQuery: FetchQueryObject = {
  headers: ["Thread-Index", "Message-ID", "References", "In-Reply-To"]
};

type OutlookFolderRole = "sent" | "draft" | "deleted";
type OutlookFolder = ListResponse & { role?: OutlookFolderRole };

type OutlookImapProviderOptions = {
  clientFactory?: () => ImapFlow;
};

export class OutlookImapProvider {
  private client?: ImapFlow;
  private folders?: OutlookFolder[];
  private participatedEvidence = new Set<string>();
  private metrics = {
    folders: 0,
    metadataBatches: 0,
    commands: 0,
    retries: 0,
    errors: 0,
    peakRetainedMemoryMb: 0,
    evidenceAvailability: {
      conversationIdentity: true,
      importance: true,
      categories: false,
      listId: true,
      listUnsubscribe: true,
      autoSubmitted: true,
      precedence: true
    }
  };

  constructor(
    private readonly accessToken: string,
    private readonly accountEmail: string,
    private readonly options: OutlookImapProviderOptions = {}
  ) {}

  getScanMetrics() {
    return { ...this.metrics };
  }

  async scanParticipatedConversationIds(input: Pick<ScanMetadataInput, "batchSize" | "signal">) {
    try {
      const client = await this.getClient(input.signal);
      const folders = await this.getFolders(client);
      const evidence = new Set<string>();
      for (const folder of folders.filter((candidate) => candidate.role === "sent")) {
        throwIfAborted(input.signal);
        const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
        if (mailbox.readOnly !== true) throw new Error("Outlook IMAP Sent folder was not opened read-only.");
        for (let start = 1; start <= mailbox.exists; start += input.batchSize) {
          const end = Math.min(start + input.batchSize - 1, mailbox.exists);
          this.metrics.metadataBatches += 1;
          for await (const message of client.fetch(`${start}:${end}`, outlookImapParticipationFetchQuery, { uid: false })) {
            throwIfAborted(input.signal);
            for (const identity of deriveThreadEvidence(message.headers)) evidence.add(identity);
            this.observeRetainedBytes(message.headers?.byteLength ?? 0);
          }
        }
      }
      this.participatedEvidence = evidence;
      return new Set(evidence);
    } catch (error) {
      this.metrics.errors += 1;
      throw error;
    }
  }

  async *scanMetadata(input: ScanMetadataInput): AsyncIterable<ScanMetadataBatch> {
    let processed = 0;
    const numericLimit = input.limit === undefined || input.limit === "full" ? undefined : input.limit;
    try {
      const client = await this.getClient(input.signal);
      const folders = await this.getFolders(client);
      input.onConnected?.({ mailboxPath: "Outlook IMAP folders", mailboxExists: 0, readOnly: true });

      for (const folder of folders) {
        if (numericLimit !== undefined && processed >= numericLimit) break;
        throwIfAborted(input.signal);
        const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
        if (mailbox.readOnly !== true) throw new Error("Outlook IMAP folder was not opened read-only.");
        this.metrics.folders += 1;
        for (let start = 1; start <= mailbox.exists; start += input.batchSize) {
          if (numericLimit !== undefined && processed >= numericLimit) break;
          const end = Math.min(start + input.batchSize - 1, mailbox.exists);
          const records: NormalizedMailboxRecord[] = [];
          let subjectProtectionMs = 0;
          this.metrics.metadataBatches += 1;
          for await (const message of client.fetch(`${start}:${end}`, outlookImapFetchQuery, { uid: false })) {
            throwIfAborted(input.signal);
            if (numericLimit !== undefined && processed >= numericLimit) break;
            const subjectStarted = performance.now();
            const subjectProtection = deriveSubjectProtection(parseHeaderValue(message.headers, "Subject"));
            subjectProtectionMs += performance.now() - subjectStarted;
            records.push(normalizeOutlookImapMessage({
              message,
              folder,
              uidValidity: mailbox.uidValidity,
              participatedEvidence: this.participatedEvidence,
              subjectProtection
            }));
            this.observeRetainedBytes(message.headers?.byteLength ?? 0);
            processed += 1;
          }
          yield { records, subjectProtectionMs };
        }
      }
    } catch (error) {
      this.metrics.errors += 1;
      throw error;
    }
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    } finally {
      this.client = undefined;
      this.folders = undefined;
    }
  }

  private async getClient(signal?: AbortSignal) {
    if (this.client) return this.client;
    throwIfAborted(signal);
    if (!this.accessToken || !this.accountEmail) throw new Error("Outlook IMAP credentials are unavailable.");
    const client = this.options.clientFactory?.() ?? new ImapFlow({
      host: env.OUTLOOK_IMAP_HOST,
      port: env.OUTLOOK_IMAP_PORT,
      secure: true,
      logger: false,
      emitLogs: true,
      disableAutoIdle: true,
      auth: { user: this.accountEmail, accessToken: this.accessToken },
      tls: { rejectUnauthorized: true }
    });
    client.on("log", (entry) => {
      if (entry.src === "c" && typeof entry.msg === "string" && /^[A-Z0-9]+\s/.test(entry.msg)) {
        this.metrics.commands += 1;
      }
    });
    await client.connect();
    this.client = client;
    return client;
  }

  private async getFolders(client: ImapFlow) {
    if (this.folders) return this.folders;
    const listed = await client.list();
    const selectable = listed.filter((folder) => !hasFlag(folder.flags, "\\NOSELECT"));
    const roots = selectable
      .map((folder) => ({ folder, role: specialUseRole(folder) }))
      .filter((entry): entry is { folder: ListResponse; role: OutlookFolderRole } => Boolean(entry.role));
    for (const requiredRole of ["sent", "draft", "deleted"] satisfies OutlookFolderRole[]) {
      if (!roots.some((root) => root.role === requiredRole)) {
        throw new Error("Outlook IMAP did not identify all protected system folders.");
      }
    }
    this.folders = selectable.map((folder) => ({
      ...folder,
      role: roots.find((root) => isFolderOrDescendant(folder, root.folder))?.role
    }));
    return this.folders;
  }

  private observeRetainedBytes(headerBytes: number) {
    const estimateMb = (Math.max(0, headerBytes) * outlookImapBatchSize * 2) / 1024 / 1024;
    this.metrics.peakRetainedMemoryMb = Math.max(this.metrics.peakRetainedMemoryMb, estimateMb);
  }
}

export function normalizeOutlookImapMessage(input: {
  message: FetchMessageObject;
  folder: OutlookFolder;
  uidValidity: bigint;
  participatedEvidence: ReadonlySet<string>;
  subjectProtection: NormalizedMailboxRecord["subjectProtection"];
}): NormalizedMailboxRecord {
  const sender = parseSender(parseHeaderValue(input.message.headers, "From"));
  const flags = new Set([...(input.message.flags ?? [])].map((flag) => flag.trim().toUpperCase()));
  const userLabels = [...(input.message.flags ?? [])]
    .map((flag) => flag.trim())
    .filter((flag) => flag.length > 0 && !flag.startsWith("\\"));
  const evidence = deriveThreadEvidence(input.message.headers);
  const participated = evidence.find((identity) => input.participatedEvidence.has(identity));
  const receivedAt = input.message.internalDate instanceof Date
    ? input.message.internalDate
    : input.message.internalDate ? new Date(input.message.internalDate) : new Date(Number.NaN);
  const hasValidDate = !Number.isNaN(receivedAt.getTime());
  const importance = parseHeaderValue(input.message.headers, "Importance")?.trim().toLowerCase();
  const priority = parseHeaderValue(input.message.headers, "X-Priority")?.trim().charAt(0);

  return {
    providerMessageId: hashEvidence(`${input.folder.path}\0${input.uidValidity}\0${input.message.uid}`),
    provider: "microsoft",
    senderAddress: sender.address,
    senderDisplayName: sender.displayName,
    senderDomain: sender.domain,
    receivedAt: hasValidDate ? receivedAt : new Date(),
    isRead: flags.has("\\SEEN"),
    userLabels,
    hasListUnsubscribe: Boolean(parseHeaderValue(input.message.headers, "List-Unsubscribe")),
    listId: parseHeaderValue(input.message.headers, "List-Id"),
    autoSubmitted: parseHeaderValue(input.message.headers, "Auto-Submitted")?.trim().toLowerCase(),
    precedence: parseHeaderValue(input.message.headers, "Precedence")?.trim().toLowerCase(),
    isStarred: flags.has("\\FLAGGED"),
    isImportant: importance === "high" || priority === "1" || priority === "2",
    isSent: input.folder.role === "sent",
    isDraft: input.folder.role === "draft" || flags.has("\\DRAFT"),
    isDeleted: input.folder.role === "deleted",
    isExcludedMailboxLocation: input.folder.role === "deleted",
    hasUncertainMetadata: sender.address === "unknown@unknown.invalid" || !hasValidDate,
    conversationId: participated ?? evidence[0],
    subjectProtection: input.subjectProtection
  };
}

export function deriveThreadEvidence(headers: Buffer | undefined) {
  const evidence = new Set<string>();
  const threadIndex = parseHeaderValue(headers, "Thread-Index");
  if (threadIndex) {
    try {
      const root = Buffer.from(threadIndex.replace(/\s+/g, ""), "base64").subarray(0, 22);
      if (root.length === 22) evidence.add(hashEvidence(`thread-index:${root.toString("base64")}`));
    } catch {
      // Other identifiers may still provide conservative participation evidence.
    }
  }
  for (const name of ["Message-ID", "References", "In-Reply-To"]) {
    const value = parseHeaderValue(headers, name);
    for (const match of value?.match(/<[^<>\s]+>/g) ?? []) {
      evidence.add(hashEvidence(`message-id:${match.toLowerCase()}`));
    }
  }
  return [...evidence];
}

function specialUseRole(folder: ListResponse): OutlookFolderRole | undefined {
  const values = [folder.specialUse, ...folder.flags].filter(Boolean).map((value) => String(value).toUpperCase());
  if (values.includes("\\SENT")) return "sent";
  if (values.includes("\\DRAFTS")) return "draft";
  if (values.includes("\\TRASH")) return "deleted";
  return undefined;
}

function isFolderOrDescendant(folder: ListResponse, root: ListResponse) {
  if (folder.path === root.path) return true;
  const delimiter = root.delimiter || folder.delimiter;
  return Boolean(delimiter && folder.path.startsWith(`${root.path}${delimiter}`));
}

function hasFlag(flags: Set<string> | undefined, expected: string) {
  return [...(flags ?? [])].some((flag) => flag.toUpperCase() === expected);
}

function hashEvidence(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Outlook IMAP benchmark cancelled.", "AbortError");
}
