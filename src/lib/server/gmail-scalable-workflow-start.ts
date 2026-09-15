import "server-only";
import { start } from "workflow/api";
import { runtimeConfig } from "@/lib/config";
import { assertProductionCleanupInfrastructure, type CleanupAccess } from "@/lib/server/production-cleanup";
import {
  gmailScalableCleanupWorkflow,
  gmailScalableUndoWorkflow
} from "@/workflows/gmail-scalable-cleanup";

export async function startGmailScalableCleanupWorkflow(cleanupJobId: string) {
  assertWorkflowStart(cleanupJobId, "forward");
  return start(gmailScalableCleanupWorkflow, [cleanupJobId]);
}

export async function startGmailScalableUndoWorkflow(cleanupJobId: string) {
  assertWorkflowStart(cleanupJobId, "recovery");
  return start(gmailScalableUndoWorkflow, [cleanupJobId]);
}

function assertWorkflowStart(cleanupJobId: string, access: CleanupAccess) {
  if (process.env.NODE_ENV === "production") assertProductionCleanupInfrastructure("gmail", access);
  else if (!runtimeConfig.gmailScalableWorkflowEnabled) throw new Error("Durable Gmail cleanup workflows are disabled.");
  if (runtimeConfig.gmailScalableStoreAdapter !== "prisma") {
    throw new Error("Durable Gmail cleanup workflows require the Prisma cleanup-state adapter.");
  }
  if (!cleanupJobId || cleanupJobId.length > 128) throw new Error("An opaque cleanup job ID is required.");
}
