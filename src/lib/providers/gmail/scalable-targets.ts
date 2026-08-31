import type { ClassifiedMessage } from "@/lib/domain/types";
import { gmailImapDecimalIdToApiHex } from "@/lib/providers/gmail/id-bridge";
import {
  allocateCleanupCountAcrossGroups,
  type CleanupSenderGroup
} from "@/lib/providers/gmail/cleanup-candidates";

export type GmailScalableScanIdentity = {
  providerMessageId: string;
  uid: number;
  apiMessageId: string;
  scanOrdinal: number;
};

export type GmailScalableCleanupTarget = {
  uid: number;
  apiMessageId: string;
  groupIndex: number;
  immutableEvidence: {
    eligibleAtScan: true;
    subjectProtected: false;
    participatedConversation: false;
    protectedAtScan: false;
    ageBand: ClassifiedMessage["ageBand"];
    cleanupSignals: ClassifiedMessage["cleanupSignals"];
  };
};

export type GmailScalableEligibleIdentity = GmailScalableScanIdentity & {
  senderKey: string;
  immutableEvidence: GmailScalableCleanupTarget["immutableEvidence"];
};

export function createGmailScalableScanIdentity(input: {
  uid?: number;
  emailId?: string;
  scanOrdinal: number;
}): GmailScalableScanIdentity | undefined {
  if (!input.uid || !input.emailId) return undefined;
  return {
    providerMessageId: `gmail-uid-${input.uid}`,
    uid: input.uid,
    apiMessageId: gmailImapDecimalIdToApiHex(input.emailId),
    scanOrdinal: input.scanOrdinal
  };
}

export function toGmailScalableEligibleIdentity(
  identity: GmailScalableScanIdentity,
  classified: ClassifiedMessage
): GmailScalableEligibleIdentity | undefined {
  if (!classified.eligibleForCleanup || classified.isProtected || classified.subjectProtection) return undefined;
  return {
    ...identity,
    senderKey: classified.senderAddress.toLocaleLowerCase("en-US"),
    immutableEvidence: {
      eligibleAtScan: true,
      subjectProtected: false,
      participatedConversation: false,
      protectedAtScan: false,
      ageBand: classified.ageBand,
      cleanupSignals: [...classified.cleanupSignals]
    }
  };
}

export function allocateGmailScalableCleanupTargets(
  groups: readonly CleanupSenderGroup[],
  targets: readonly GmailScalableCleanupTarget[],
  requestedCount: number
) {
  const allocations = allocateCleanupCountAcrossGroups([...groups], requestedCount);
  const allocated = allocations.flatMap(({ group, requestedCount: groupCount }) =>
    targets.filter((target) => target.groupIndex === group.index).slice(0, groupCount)
  );
  if (new Set(allocated.map((target) => target.apiMessageId)).size !== allocated.length) {
    throw new Error("The accepted scalable target allocation contains duplicate Gmail identities.");
  }
  return allocated;
}
