import { vi } from "vitest";

type Connection = {
  id: string;
  userId: string;
  sessionGeneration: string | null;
  disconnectedAt: Date | null;
  encryptedAccessToken: string | null;
  tokenVersion: number;
};

type Where = Partial<Omit<Connection, "encryptedAccessToken">> & {
  encryptedAccessToken?: { not: null };
};

export function createSessionConnectionFixture() {
  const rows = new Map<string, Connection>();
  function reset() {
    rows.clear();
    for (const [id, userId] of [
      ["connection-1", "user-1"],
      ["connection-2", "user-1"],
      ["connection-3", "user-1"],
      ["other-connection", "user-2"]
    ]) {
      rows.set(id, { id, userId, sessionGeneration: null, disconnectedAt: null, encryptedAccessToken: "encrypted-access", tokenVersion: 0 });
    }
  }
  function match(where: Where) {
    return [...rows.values()].find((row) => Object.entries(where).every(([key, value]) =>
      key === "encryptedAccessToken"
        ? row.encryptedAccessToken !== null
        : row[key as keyof Connection] === value
    ));
  }
  reset();
  return {
    rows,
    reset,
    client: {
      providerConnection: {
        update: vi.fn(async ({ where, data }: { where: Where; data: Partial<Connection> }) => {
          const row = match(where);
          if (!row) throw new Error("Connection does not match.");
          Object.assign(row, data);
          return { id: row.id };
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Connection> }) => {
          const row = match(where);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
        findFirst: vi.fn(async ({ where }: { where: Where }) => {
          const row = match(where);
          return row ? { id: row.id } : null;
        })
      }
    }
  };
}
