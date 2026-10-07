import "server-only";
import { prisma } from "@/lib/server/db";
import { getActiveGmailConnection } from "@/lib/server/gmail-connection";
import { getActiveMicrosoftConnection } from "@/lib/server/microsoft-connection";
import { createCleanupRequestFence } from "@/lib/server/provider-work-fence";
import { createProviderRequestCoordinator } from "@/lib/server/provider-request-coordinator";
import { assertProductionCleanupInfrastructure, requireProductionCleanupAccess } from "@/lib/server/production-cleanup";
import { deletionProvider, type DeleteJob, type PermanentDeleteTransport } from "@/lib/server/permanent-delete";

export async function permanentDeleteTransport(job: DeleteJob, owner: string): Promise<PermanentDeleteTransport> {
  const provider = deletionProvider(job);
  // Existing-job ownership/connection checks do not require a second payment.
  assertProductionCleanupInfrastructure(provider, "forward");
  const aggregate = await prisma.cleanupJob.findUniqueOrThrow({ where: { id: job.view.id }, select: { scan: { select: { providerConnectionId: true, provider: true } } } });
  if (aggregate.scan.provider !== provider) throw new Error("Provider mismatch.");
  await requireProductionCleanupAccess({ userId: job.userId, jobId: job.view.id, provider,
    providerConnectionId: aggregate.scan.providerConnectionId, access: "recovery" });
  const active = provider === "gmail" ? await getActiveGmailConnection(job.userId, aggregate.scan.providerConnectionId)
    : await getActiveMicrosoftConnection(job.userId, aggregate.scan.providerConnectionId);
  if (!active) throw new Error("Connection unavailable.");
  const fence = createCleanupRequestFence(active.connection, job.view.id, owner, undefined, "forward");
  const coordinate = createProviderRequestCoordinator(active.connection.id, { beforeRequest: fence });
  const base = provider === "gmail" ? "https://gmail.googleapis.com/gmail/v1/users/me/messages/" : "https://graph.microsoft.com/v1.0/me/messages/";
  const request = async (id: string, suffix: string, method: "GET" | "POST" | "DELETE") => coordinate(async () => {
    await fence();
    return fetch(base + encodeURIComponent(id) + suffix, { method, headers: { Authorization: `Bearer ${active.accessToken}` },
      signal: AbortSignal.timeout(20_000), cache: "no-store", redirect: "error" });
  });
  return {
    async recheck(target) {
      const response = await request(target.messageId, provider === "gmail" ? "?format=minimal&fields=id,labelIds" : "?$select=id,parentFolderId", "GET");
      if (response.status === 404) return "excluded";
      if (!response.ok) return "uncertain";
      const body = await response.json() as { id?: unknown; labelIds?: unknown; parentFolderId?: unknown };
      if (body.id !== target.messageId) return "uncertain";
      if (provider === "gmail") return Array.isArray(body.labelIds) && body.labelIds.every(v => typeof v === "string")
        ? body.labelIds.includes("TRASH") ? "eligible" : "excluded" : "uncertain";
      return typeof body.parentFolderId === "string" && target.folderId
        ? body.parentFolderId === target.folderId ? "eligible" : "excluded" : "uncertain";
    },
    async remove(target) {
      const response = await request(target.messageId, provider === "gmail" ? "" : "/permanentDelete", provider === "gmail" ? "DELETE" : "POST");
      return provider === "gmail" ? response.status === 200 || response.status === 204 : response.status === 204;
    }
  };
}
