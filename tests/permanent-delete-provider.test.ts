import { afterEach, expect, it, vi } from "vitest";
import { permanentDeleteTransport } from "@/lib/server/permanent-delete-provider";
import type { DeleteJob } from "@/lib/server/permanent-delete";

const mocks = vi.hoisted(() => ({ provider: "gmail", fence: vi.fn(), access: vi.fn(), gate: vi.fn() }));
vi.mock("@/lib/server/db", () => ({ prisma: { cleanupJob: { findUniqueOrThrow: async () => ({ scan: { provider: mocks.provider, providerConnectionId: "connection" } }) } } }));
vi.mock("@/lib/server/gmail-connection", () => ({ getActiveGmailConnection: async () => ({ accessToken: "synthetic", connection: { id: "connection" } }) }));
vi.mock("@/lib/server/microsoft-connection", () => ({ getActiveMicrosoftConnection: async () => ({ accessToken: "synthetic", connection: { id: "connection" } }) }));
vi.mock("@/lib/server/production-cleanup", () => ({ assertProductionCleanupInfrastructure: mocks.gate, requireProductionCleanupAccess: mocks.access }));
vi.mock("@/lib/server/provider-work-fence", () => ({ createCleanupRequestFence: () => mocks.fence }));
vi.mock("@/lib/server/provider-request-coordinator", () => ({ createProviderRequestCoordinator: () => (request: () => Promise<unknown>) => request() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
const target = { key: "0", messageId: "exact/id", folderId: "deleted", state: "pending" as const };
async function transport(provider: "gmail" | "microsoft") {
  mocks.provider = provider;
  return permanentDeleteTransport({ ...(provider === "microsoft" ? { provider } : {}), userId: "owner", view: { id: "job" } } as DeleteJob, "worker");
}
it.each(["gmail", "microsoft"] as const)("uses exact %s endpoints, minimal location reads and no destructive retries", async provider => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(provider === "gmail" ? { id: target.messageId, labelIds: ["TRASH"] } : { id: target.messageId, parentFolderId: "deleted" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 })).mockRejectedValueOnce(new Error("network"));
  vi.stubGlobal("fetch", fetcher);
  const api = await transport(provider);
  expect(await api.recheck(target)).toBe("eligible");
  expect(await api.remove(target)).toBe(true);
  const [url, options] = fetcher.mock.calls[1];
  expect(url).toBe(provider === "gmail" ? "https://gmail.googleapis.com/gmail/v1/users/me/messages/exact%2Fid" : "https://graph.microsoft.com/v1.0/me/messages/exact%2Fid/permanentDelete");
  expect(options.method).toBe(provider === "gmail" ? "DELETE" : "POST");
  await expect(api.remove(target)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(mocks.fence).toHaveBeenCalledTimes(3);
});
it.each(["gmail", "microsoft"] as const)("excludes restored %s locations and treats missing/invalid evidence conservatively", async provider => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(provider === "gmail" ? { id: target.messageId, labelIds: ["INBOX"] } : { id: target.messageId, parentFolderId: "inbox" }))
    .mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(Response.json({ id: "different" }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const api = await transport(provider);
  expect(await api.recheck(target)).toBe("excluded");
  expect(await api.recheck(target)).toBe("excluded");
  expect(await api.recheck(target)).toBe("uncertain");
  expect(await api.remove(target)).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it("lost authorization prevents any provider request", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const api = await transport("gmail");
  mocks.fence.mockRejectedValueOnce(new Error("revoked"));
  await expect(api.remove(target)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
