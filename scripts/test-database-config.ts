function databaseTarget(value: string) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error("An isolated PostgreSQL test database URL is required.");
  }
  const host = url.hostname.toLowerCase();
  // Prisma's shared proxy hosts identify databases by user; Neon poolers share their direct target.
  return `${host === "db.prisma.io" || host === "pooled.db.prisma.io" ? `prisma:${url.username}` : host.replace("-pooler.", ".")}${url.pathname}`;
}

export function isolatedTestDatabase(input: Record<string, string | undefined>) {
  if (!input.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a separate disposable database; application DATABASE_URL is never a fallback.");
  try {
    const target = databaseTarget(input.TEST_DATABASE_URL);
    if (input.DATABASE_URL && target === databaseTarget(input.DATABASE_URL)) {
      throw new Error("Test and application databases must be different.");
    }
    return input.TEST_DATABASE_URL;
  } catch {
    throw new Error("TEST_DATABASE_URL must be valid and isolated from the application database. No database was contacted.");
  }
}
