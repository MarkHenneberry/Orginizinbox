import { describe, expect, it } from "vitest";
import { isolatedTestDatabase } from "../scripts/test-database-config";

describe("database test isolation", () => {
  it("never falls back to the application database", () => {
    expect(() => isolatedTestDatabase({ DATABASE_URL: "postgresql://secret@db.example/app" })).toThrow("TEST_DATABASE_URL");
  });
  it("rejects a blank test URL even when an application database is configured", () => {
    expect(() => isolatedTestDatabase({ DATABASE_URL: "postgresql://secret@db.example/app", TEST_DATABASE_URL: "" })).toThrow("TEST_DATABASE_URL");
  });
  it("rejects an exactly identical application/test URL before any connection", () => {
    const url = "postgresql://u:private-password@localhost/organizinbox";
    expect(() => isolatedTestDatabase({ DATABASE_URL: url, TEST_DATABASE_URL: url })).toThrow("No database was contacted");
  });
  it("rejects same-target URLs even with different passwords, query parameters or pooler aliases", () => {
    for (const [app, test] of [
      ["postgresql://one:secret@db.example/app", "postgresql://two:other@db.example/app?sslmode=require"],
      ["postgres://database:secret@db.prisma.io/postgres", "postgres://database:other@pooled.db.prisma.io/postgres"],
      ["postgres://u:s@ep-test.neon.tech/app", "postgres://u:s@ep-test-pooler.neon.tech/app"]
    ]) expect(() => isolatedTestDatabase({ DATABASE_URL: app, TEST_DATABASE_URL: test })).toThrow("isolated");
  });
  it("permits an explicit separate test database and never exposes invalid secret input", () => {
    const test = "postgresql://u:s@localhost/organizinbox_test";
    expect(isolatedTestDatabase({ DATABASE_URL: "postgresql://u:s@localhost/organizinbox", TEST_DATABASE_URL: test })).toBe(test);
    expect(() => isolatedTestDatabase({ TEST_DATABASE_URL: "private-token-invalid" })).toThrow("No database was contacted");
    try { isolatedTestDatabase({ TEST_DATABASE_URL: "private-token-invalid" }); }
    catch (error) { expect(String(error)).not.toContain("private-token"); }
  });
});
