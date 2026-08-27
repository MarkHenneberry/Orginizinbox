import type { EmailProviderName } from "@/lib/domain/types";

export type PersistentScanRecord = {
  id: string;
  userId: string;
  providerConnectionId: string;
  provider: EmailProviderName;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  completedAt?: string;
  failureCode?: string;
};

export function serializePersistentScanRecord(record: PersistentScanRecord): PersistentScanRecord {
  return { ...record };
}
