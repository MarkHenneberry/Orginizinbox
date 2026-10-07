import { FatalError } from "workflow";

export async function permanentDeleteWorkflow(jobId: string) {
  "use workflow";
  while ((await permanentDeleteStep(jobId)).outcome === "continue") { /* Bounded durable units. */ }
}

export async function permanentDeleteStep(jobId: string) {
  "use step";
  try {
    const { advancePermanentDelete } = await import("@/lib/server/permanent-delete");
    const { permanentDeleteTransport } = await import("@/lib/server/permanent-delete-provider");
    const { PrismaCleanupJobStore } = await import("@/lib/server/cleanup-job-store");
    return await advancePermanentDelete(jobId, new PrismaCleanupJobStore(), permanentDeleteTransport);
  } catch { throw new FatalError("Permanent deletion stopped safely. Check its status before continuing."); }
}
permanentDeleteStep.maxRetries = 0;
