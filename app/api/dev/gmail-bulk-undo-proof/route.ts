import { NextResponse } from "next/server";
import { runtimeConfig } from "@/lib/config";
import { assertGmailBulkUndoProofInput, executeGmailBulkUndoProof } from "@/lib/providers/gmail/bulk-undo-proof";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { getGmailCleanupJob, updateGmailCleanupJob } from "@/lib/server/gmail-cleanup-store";
import { getSession } from "@/lib/server/session";

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const body = await request.json() as { jobId?: string; approved?: boolean };
    if (!body.jobId) return NextResponse.json({ error: "Cleanup result id is required." }, { status: 400 });
    const job = getGmailCleanupJob(session.userId, body.jobId);
    if (
      !job ||
      job.status !== "completed" ||
      job.attemptedCount !== 5 ||
      job.apiCandidates.length !== 5 ||
      job.verifiedCount !== job.attemptedCount ||
      job.failedCount !== 0 ||
      job.uncertainCount !== 0
    ) {
      return NextResponse.json({ error: "A fully verified five-message Trash result is required." }, { status: 409 });
    }
    const targetIds = assertGmailBulkUndoProofInput({
      enabled: runtimeConfig.gmailBulkUndoProofEnabled,
      approved: body.approved === true,
      nodeEnv: process.env.NODE_ENV,
      targetIds: job.apiCandidates.map((candidate) => candidate.apiMessageId)
    });
    const connection = await getActiveGmailConnection(session.userId, session.providerConnectionId);
    if (!connection) return NextResponse.json({ error: "Gmail connection required." }, { status: 409 });
    const result = await executeGmailBulkUndoProof({ accessToken: connection.accessToken, targetIds });
    const fullyRestored = result.verifiedRestoredCount === result.attemptedCount;
    updateGmailCleanupJob(job, {
      status: fullyRestored ? "undone" : "undo_partial",
      diagnosticResult: fullyRestored ? "UNDO_SUCCESS" : "UNDO_PARTIAL",
      undoAttemptedCount: result.attemptedCount,
      undoVerifiedCount: result.verifiedRestoredCount,
      undoFailedCount: result.failedCount,
      undoUncertainCount: result.uncertainCount,
      operationStates: { ...job.operationStates, undo: fullyRestored ? "completed" : "partial" },
      completedAt: Date.now()
    });
    return NextResponse.json({ result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Gmail bulk Undo proof failed." },
      { status: 400 }
    );
  }
}
