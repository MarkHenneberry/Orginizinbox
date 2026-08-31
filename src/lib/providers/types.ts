import type { EmailProviderName, NormalizedMailboxRecord } from "@/lib/domain/types";
import type { GmailScalableScanIdentity } from "@/lib/providers/gmail/scalable-targets";

export type MailboxProfile = {
  provider: EmailProviderName;
  externalAccountId: string;
  displayName?: string;
  messageCount?: number;
};

export type ScanMetadataInput = {
  cursor?: string;
  batchSize: number;
  limit?: number | "full";
  signal?: AbortSignal;
  onConnected?: (input: {
    mailboxPath: string;
    mailboxExists: number;
    readOnly: boolean;
    uidValidity?: string;
    scalableIdentityBridgeAvailable?: boolean;
  }) => void;
};

export type ScanMetadataBatch = {
  records: NormalizedMailboxRecord[];
  gmailScalableIdentities?: GmailScalableScanIdentity[];
  subjectProtectionMs?: number;
  nextCursor?: string;
  mailboxExists?: number;
};

export type MoveApprovedMessagesToTrashInput = {
  transientProviderMessageIds: string[];
  idempotencyKey: string;
};

export type MoveApprovedMessagesToTrashResult = {
  requested: number;
  moved: number;
  failed: number;
  retryableProviderMessageIds: string[];
};

export type SearchCleanupGroupInput = {
  groupKey: string;
  batchSize: number;
};

export type SearchCleanupGroupBatch = {
  transientProviderMessageIds: string[];
  nextCursor?: string;
};

export interface MailboxProcessor {
  getMailboxProfile(): Promise<MailboxProfile>;
  scanMetadata(input: ScanMetadataInput): AsyncIterable<ScanMetadataBatch>;
  searchCleanupGroup(input: SearchCleanupGroupInput): AsyncIterable<SearchCleanupGroupBatch>;
  moveApprovedMessagesToTrash(input: MoveApprovedMessagesToTrashInput): Promise<MoveApprovedMessagesToTrashResult>;
  disconnect(): Promise<void>;
}
