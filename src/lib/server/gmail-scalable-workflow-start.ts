import "server-only";
import { start } from "workflow/api";
import { runtimeConfig } from "@/lib/config";
import {
  gmailScalableCleanupWorkflow,
  gmailScalableUndoWorkflow
} from "@/workflows/gmail-scalable-cleanup";

export async function startGmailScalableCleanupWorkflow(cleanupJobId: string) {
  assertWorkflowStart(cleanupJobId);
  return start(gmailScalableCleanupWorkflow, [cleanupJobId]);
}

export async function startGmailScalableUndoWorkflow(cleanupJobId: string) {
  assertWorkflowStart(cleanupJobId);
  return start(gmailScalableUndoWorkflow, [cleanupJobId]);
}

function assertWorkflowStart(cleanupJobId: string) {
  if (!runtimeConfig.gmailScalableWorkflowEnabled) throw new Error("Durable Gmail cleanup workflows are disabled.");
  if (runtimeConfig.gmailScalableStoreAdapter !== "prisma") {
    throw new Error("Durable Gmail cleanup workflows require the Prisma cleanup-state adapter.");
  }
  if (!cleanupJobId || cleanupJobId.length > 128) throw new Error("An opaque cleanup job ID is required.");
}
