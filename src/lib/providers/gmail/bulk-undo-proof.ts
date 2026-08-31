import "server-only";
import { mapWithConcurrency } from "@/lib/providers/gmail/gmail-api-client";

const gmailApiMessagesUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const gmailBulkUndoProofSize = 25;

export type GmailBulkUndoProofResult = {
  attemptedCount: number;
  verifiedRestoredCount: number;
  failedCount: number;
  uncertainCount: number;
  batchModifyRequests: number;
  verificationRequests: number;
  apiResult: "success" | "failure";
  mutationMs: number;
  verificationMs: number;
  totalMs: number;
  verifiedRestoredIds: string[];
  stillInTrashIds: string[];
  uncertainIds: string[];
};

export function parseGmailBulkUndoProofRequest(value: unknown): { jobId?: string; approved: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Gmail bulk Undo proof request.");
  }
  const body = value as Record<string, unknown>;
  const allowedFields = new Set(["jobId", "approved"]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    throw new Error("Invalid Gmail bulk Undo proof request.");
  }
  return {
    jobId: typeof body.jobId === "string" ? body.jobId : undefined,
    approved: body.approved === true
  };
}

export function assertGmailBulkUndoProofInput(input: {
  enabled: boolean;
  historyShadowEnabled: boolean;
  approved: boolean;
  nodeEnv: string | undefined;
  targetIds: readonly string[];
}) {
  if (input.nodeEnv === "production" || !input.enabled || !input.historyShadowEnabled || !input.approved) {
    throw new Error("Gmail bulk Undo proof is disabled.");
  }
  if (input.targetIds.some((id) => !id) || new Set(input.targetIds).size !== input.targetIds.length) {
    throw new Error("Gmail bulk Undo proof requires unique valid message IDs.");
  }
  if (input.targetIds.length !== gmailBulkUndoProofSize) {
    throw new Error(`Gmail bulk Undo proof requires exactly ${gmailBulkUndoProofSize} messages.`);
  }
  return [...input.targetIds];
}

export async function executeGmailBulkUndoProof(input: {
  accessToken: string;
  targetIds: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<GmailBulkUndoProofResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const startedAt = performance.now();
  const mutationStartedAt = performance.now();
  let response: Response | undefined;
  try {
    response = await fetchImpl(`${gmailApiMessagesUrl}/batchModify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ids: input.targetIds, addLabelIds: [], removeLabelIds: ["TRASH"] })
    });
  } catch {
    response = undefined;
  }
  const mutationMs = Math.round(performance.now() - mutationStartedAt);
  if (!response?.ok) {
    return {
      attemptedCount: input.targetIds.length,
      verifiedRestoredCount: 0,
      failedCount: 0,
      uncertainCount: input.targetIds.length,
      batchModifyRequests: 1,
      verificationRequests: 0,
      apiResult: "failure",
      mutationMs,
      verificationMs: 0,
      totalMs: Math.round(performance.now() - startedAt),
      verifiedRestoredIds: [],
      stillInTrashIds: [],
      uncertainIds: [...input.targetIds]
    };
  }

  const verificationStartedAt = performance.now();
  const outcomes = await mapWithConcurrency(input.targetIds, 8, async (id) => {
    let verification: Response;
    try {
      verification = await fetchImpl(
        `${gmailApiMessagesUrl}/${encodeURIComponent(id)}?format=metadata&fields=id,labelIds`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } }
      );
    } catch {
      return "uncertain" as const;
    }
    if (!verification.ok) {
      return "uncertain" as const;
    }
    let body: { id?: string; labelIds?: string[] };
    try {
      body = await verification.json() as { id?: string; labelIds?: string[] };
    } catch {
      return "uncertain" as const;
    }
    if (body.id !== id || !Array.isArray(body.labelIds)) return "uncertain" as const;
    return body.labelIds.some((label) => label.toUpperCase() === "TRASH")
      ? "still-in-trash" as const
      : "verified" as const;
  });
  const verificationMs = Math.round(performance.now() - verificationStartedAt);
  const verifiedRestoredIds = input.targetIds.filter((_, index) => outcomes[index] === "verified");
  const stillInTrashIds = input.targetIds.filter((_, index) => outcomes[index] === "still-in-trash");
  const uncertainIds = input.targetIds.filter((_, index) => outcomes[index] === "uncertain");

  return {
    attemptedCount: input.targetIds.length,
    verifiedRestoredCount: verifiedRestoredIds.length,
    failedCount: stillInTrashIds.length,
    uncertainCount: uncertainIds.length,
    batchModifyRequests: 1,
    verificationRequests: input.targetIds.length,
    apiResult: "success",
    mutationMs,
    verificationMs,
    totalMs: Math.round(performance.now() - startedAt),
    verifiedRestoredIds,
    stillInTrashIds,
    uncertainIds
  };
}
