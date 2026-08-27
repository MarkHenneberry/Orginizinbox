import "server-only";

const gmailApiMessagesUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const gmailBulkUndoProofSize = 5;

export type GmailBulkUndoProofResult = {
  attemptedCount: number;
  verifiedRestoredCount: number;
  failedCount: number;
  uncertainCount: number;
  batchModifyRequests: number;
  verificationRequests: number;
};

export function assertGmailBulkUndoProofInput(input: {
  enabled: boolean;
  approved: boolean;
  nodeEnv: string | undefined;
  targetIds: readonly string[];
}) {
  if (input.nodeEnv === "production" || !input.enabled || !input.approved) {
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
  const response = await fetchImpl(`${gmailApiMessagesUrl}/batchModify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ids: input.targetIds, addLabelIds: [], removeLabelIds: ["TRASH"] })
  });
  if (!response.ok) throw new Error(`Gmail bulk Undo proof failed with status ${response.status}.`);

  let verifiedRestoredCount = 0;
  let failedCount = 0;
  let uncertainCount = 0;
  for (const id of input.targetIds) {
    const verification = await fetchImpl(
      `${gmailApiMessagesUrl}/${encodeURIComponent(id)}?format=metadata&fields=id,labelIds`,
      { headers: { Authorization: `Bearer ${input.accessToken}` } }
    );
    if (!verification.ok) {
      uncertainCount += 1;
      continue;
    }
    let body: { id?: string; labelIds?: string[] };
    try {
      body = await verification.json() as { id?: string; labelIds?: string[] };
    } catch {
      uncertainCount += 1;
      continue;
    }
    if (body.id !== id || !Array.isArray(body.labelIds)) uncertainCount += 1;
    else if (body.labelIds.some((label) => label.toUpperCase() === "TRASH")) failedCount += 1;
    else verifiedRestoredCount += 1;
  }

  return {
    attemptedCount: input.targetIds.length,
    verifiedRestoredCount,
    failedCount,
    uncertainCount,
    batchModifyRequests: 1,
    verificationRequests: input.targetIds.length
  };
}
