import { FatalError, sleep } from "workflow";
import { CleanupStateIntegrityError } from "@/lib/server/gmail-scalable-cleanup-durable-store";
import { createGmailScalableWorkflowCoordinator } from "@/lib/server/gmail-scalable-workflow-coordinator";

export async function gmailScalableCleanupWorkflow(cleanupJobId: string) {
  "use workflow";
  for (;;) {
    const result = await runGmailScalableCleanupStep(cleanupJobId);
    if (result.outcome === "stop") return result;
    if (result.outcome === "sleep" && result.resumeAt) await sleep(new Date(result.resumeAt));
  }
}

export async function gmailScalableUndoWorkflow(cleanupJobId: string) {
  "use workflow";
  for (;;) {
    const result = await runGmailScalableUndoStep(cleanupJobId);
    if (result.outcome === "stop") return result;
    if (result.outcome === "sleep" && result.resumeAt) await sleep(new Date(result.resumeAt));
  }
}

export async function runGmailScalableCleanupStep(cleanupJobId: string) {
  "use step";
  return runSanitizedStep(cleanupJobId, "cleanup");
}

export async function runGmailScalableUndoStep(cleanupJobId: string) {
  "use step";
  return runSanitizedStep(cleanupJobId, "undo");
}

async function runSanitizedStep(cleanupJobId: string, mode: "cleanup" | "undo") {
  try {
    return await createGmailScalableWorkflowCoordinator().advance(cleanupJobId, mode);
  } catch (error) {
    if (error instanceof CleanupStateIntegrityError) {
      throw new FatalError("Encrypted cleanup state is unavailable or invalid.");
    }
    throw new Error("The Gmail cleanup step could not be completed safely.");
  }
}
