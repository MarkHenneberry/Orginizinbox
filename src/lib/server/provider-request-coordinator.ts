import "server-only";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/server/db";
import { contentionBackoff } from "@/lib/server/contention-backoff";

export function createProviderRequestCoordinator(
  providerConnectionId: string,
  input: {
    limit?: number;
    client?: Pick<PrismaClient, "providerRequestLease">;
    now?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    beforeRequest?: () => Promise<void>;
    // Read-only scans may omit the redundant pre-claim fence, never the pre-request fence.
    fenceAfterClaimOnly?: boolean;
  } = {}
) {
  const limit = Math.max(1, Math.min(4, input.limit ?? 2));
  const client = input.client ?? prisma;
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = input.random ?? Math.random;
  let slotsReady: Promise<void> | undefined;

  function ensureSlots() {
    slotsReady ??= Promise.all(Array.from({ length: limit }, (_, slot) =>
      client.providerRequestLease.upsert({
        where: { providerConnectionId_slot: { providerConnectionId, slot } },
        update: {},
        create: { providerConnectionId, slot }
      })
    )).then(() => undefined);
    return slotsReady;
  }

  return async function coordinate<T>(request: () => Promise<T>) {
    const owner = `provider-request:${randomUUID()}`;
    await ensureSlots();

    const deadline = now().getTime() + 12_000;
    for (let attempt = 0; attempt < 200 && (attempt === 0 || now().getTime() < deadline); attempt += 1) {
      if (!input.fenceAfterClaimOnly) await input.beforeRequest?.();
      const claimedAt = now();
      for (let slot = 0; slot < limit; slot += 1) {
        const claimed = await client.providerRequestLease.updateMany({
          where: {
            providerConnectionId,
            slot,
            OR: [
              { leaseOwner: null },
              { leaseExpiresAt: null },
              { leaseExpiresAt: { lte: claimedAt } }
            ]
          },
          data: { leaseOwner: owner, leaseExpiresAt: new Date(claimedAt.getTime() + 60_000) }
        });
        if (claimed.count !== 1) continue;
        try {
          await input.beforeRequest?.();
          return await request();
        } finally {
          await client.providerRequestLease.updateMany({
            where: { providerConnectionId, slot, leaseOwner: owner },
            data: { leaseOwner: null, leaseExpiresAt: null }
          });
        }
      }
      if (input.fenceAfterClaimOnly) await input.beforeRequest?.();
      await sleep(Math.min(contentionBackoff(attempt, random), Math.max(0, deadline - now().getTime())));
    }
    throw new Error("Provider request concurrency limit is busy.");
  };
}
