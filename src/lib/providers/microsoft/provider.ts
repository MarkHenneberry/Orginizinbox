import { requireMicrosoftOAuthConfig } from "@/lib/config";
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

export const microsoftScopes = {
  scan: ["offline_access", "User.Read", "Mail.ReadBasic"],
  cleanup: ["offline_access", "User.Read", "Mail.ReadWrite"]
};

export class MicrosoftProvider implements MailboxProcessor {
  constructor(private readonly accessToken: string) {
    requireMicrosoftOAuthConfig();
  }

  async getMailboxProfile(): Promise<MailboxProfile> {
    this.assertTokenPresent();
    throw new Error("Microsoft mailbox profile retrieval is not implemented until Microsoft OAuth credentials are configured.");
  }

  async *scanMetadata(_input: ScanMetadataInput): AsyncIterable<ScanMetadataBatch> {
    void _input;
    this.assertTokenPresent();
    throw new Error("Microsoft Graph metadata scanning is not implemented in this architectural pass.");
  }

  async *searchCleanupGroup(_input: SearchCleanupGroupInput): AsyncIterable<SearchCleanupGroupBatch> {
    void _input;
    this.assertTokenPresent();
    throw new Error("Microsoft cleanup-group search will query matching identifiers transiently after user approval. It is not implemented yet.");
  }

  async moveApprovedMessagesToTrash(_input: MoveApprovedMessagesToTrashInput): Promise<MoveApprovedMessagesToTrashResult> {
    void _input;
    this.assertTokenPresent();
    throw new Error("Microsoft cleanup must move messages to deleteditems. Live mutation is intentionally disabled in this first pass.");
  }

  async disconnect(): Promise<void> {
    this.assertTokenPresent();
    throw new Error("Microsoft token revocation is not implemented until OAuth persistence is enabled.");
  }

  private assertTokenPresent() {
    if (!this.accessToken) {
      throw new Error("Missing Microsoft access token.");
    }
  }
}
