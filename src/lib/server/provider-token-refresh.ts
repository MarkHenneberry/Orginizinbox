import "server-only";
import { randomUUID } from "node:crypto";
import type { EmailProviderName, PrismaClient, ProviderConnection } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";

export type ProviderRefreshResult = {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: Date | null;
  scope?: string | null;
};

export async function refreshProviderConnectionSingleFlight(input: {
  userId: string;
  connection: ProviderConnection;
  provider: EmailProviderName;
  force?: boolean;
  refreshSkewMs: number;
  refresh(refreshToken: string): Promise<ProviderRefreshResult>;
  client?: Pick<PrismaClient, "providerConnection">;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}) {
  const client = input.client ?? prisma;
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = input.random ?? Math.random;
  const initialVersion = input.connection.tokenVersion;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await client.providerConnection.findFirst({
      where: {
        id: input.connection.id,
        userId: input.userId,
        provider: input.provider,
        disconnectedAt: null
      }
    });
    if (!current?.encryptedRefreshToken || !current.encryptedAccessToken) {
      throw new Error("Provider connection cannot be refreshed.");
    }

    const refreshNeeded = current.tokenExpiresAt &&
      current.tokenExpiresAt.getTime() <= now().getTime() + input.refreshSkewMs;
    if ((!input.force && !refreshNeeded) || (input.force && current.tokenVersion > initialVersion)) return current;

    const owner = `token-refresh:${randomUUID()}`;
    const claimedAt = now();
    const claim = await client.providerConnection.updateMany({
      where: {
        id: current.id,
        userId: input.userId,
        provider: input.provider,
        tokenVersion: current.tokenVersion,
        OR: [
          { refreshLeaseOwner: null },
          { refreshLeaseExpiresAt: null },
          { refreshLeaseExpiresAt: { lte: claimedAt } }
        ]
      },
      data: {
        refreshLeaseOwner: owner,
        refreshLeaseExpiresAt: new Date(claimedAt.getTime() + 30_000)
      }
    });
    if (claim.count !== 1) {
      await sleep(25 + Math.floor(random() * 50));
      continue;
    }

    try {
      const refreshed = await input.refresh(decryptSecret(current.encryptedRefreshToken));
      const committed = await client.providerConnection.updateMany({
        where: {
          id: current.id,
          userId: input.userId,
          provider: input.provider,
          tokenVersion: current.tokenVersion,
          refreshLeaseOwner: owner,
          refreshLeaseExpiresAt: { gt: now() }
        },
        data: {
          encryptedAccessToken: encryptSecret(refreshed.accessToken),
          encryptedRefreshToken: encryptSecret(refreshed.refreshToken ?? decryptSecret(current.encryptedRefreshToken)),
          tokenExpiresAt: refreshed.tokenExpiresAt,
          scope: refreshed.scope,
          tokenVersion: { increment: 1 },
          refreshLeaseOwner: null,
          refreshLeaseExpiresAt: null
        }
      });
      if (committed.count !== 1) throw new Error("Provider token refresh lease was lost before commit.");
      const updated = await client.providerConnection.findFirst({
        where: { id: current.id, userId: input.userId, provider: input.provider, disconnectedAt: null }
      });
      if (!updated?.encryptedAccessToken || !updated.encryptedRefreshToken) {
        throw new Error("Provider token refresh did not commit usable credentials.");
      }
      return updated;
    } catch (error) {
      await client.providerConnection.updateMany({
        where: { id: current.id, refreshLeaseOwner: owner },
        data: { refreshLeaseOwner: null, refreshLeaseExpiresAt: null }
      });
      throw error;
    }
  }
  throw new Error("Provider token refresh is already in progress.");
}
