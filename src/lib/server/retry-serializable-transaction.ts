import "server-only";
import { Prisma } from "@prisma/client";

// Only use around database-only transactions: a P2034 transaction was rolled back.
export async function retrySerializableTransaction<T>(transaction: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await transaction(); }
    catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1) + Math.floor(Math.random() * 20)));
    }
  }
}
