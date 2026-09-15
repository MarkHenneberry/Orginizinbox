import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { retrySerializableTransaction } from "@/lib/server/retry-serializable-transaction";

const conflict = () => new Prisma.PrismaClientKnownRequestError("synthetic conflict", { code: "P2034", clientVersion: "6.12.0" });

describe("database-only serialization retry", () => {
  it("retries rolled-back serializable transactions within a fixed budget", async () => {
    const transaction = vi.fn().mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()).mockResolvedValue("accepted");
    expect(await retrySerializableTransaction(transaction)).toBe("accepted");
    expect(transaction).toHaveBeenCalledTimes(3);
    const exhausted = vi.fn().mockRejectedValue(conflict());
    await expect(retrySerializableTransaction(exhausted)).rejects.toMatchObject({ code: "P2034" });
    expect(exhausted).toHaveBeenCalledTimes(4);
  });
  it("never retries a duplicate key, network/scheduling failure or ambiguous error", async () => {
    for (const error of [
      new Prisma.PrismaClientKnownRequestError("synthetic duplicate", { code: "P2002", clientVersion: "6.12.0" }),
      new Error("unknown outcome"), { code: "P2034" }
    ]) {
      const transaction = vi.fn().mockRejectedValue(error);
      await expect(retrySerializableTransaction(transaction)).rejects.toBe(error);
      expect(transaction).toHaveBeenCalledTimes(1);
    }
  });
});
