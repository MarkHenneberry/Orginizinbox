import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { persistenceErrorDiagnostic } from "@/lib/server/persistence-error-diagnostic";

const clientVersion = Prisma.prismaVersion.client;
const sensitive = {
  access_token: "private-access-token", refresh_token: "private-refresh-token", id_token: "private-id-token",
  code: "private-authorization-code", state: "private-oauth-state", email: "private@example.test",
  tenantId: "private-tenant", subject: "private-subject", database: "postgresql://private:secret@private/db",
  key: "private-encryption-key", userId: "private-user-id", connectionId: "private-connection-id"
};
const message = JSON.stringify(sensitive);

describe("sanitized persistence diagnostics", () => {
  it.each(["P2002", "P2025", "P2034"])("reports only structural fields for %s without Prisma metadata", code => {
    const error = new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion, meta: sensitive });
    expect(persistenceErrorDiagnostic(error)).toEqual({
      errorName: "PrismaClientKnownRequestError", errorClass: code === "P2034" ? "serialization" : "prisma_known_request",
      prismaCode: code, prismaClientVersion: clientVersion
    });
  });

  it("classifies initialization without exposing a connection string or message", () => {
    const error = new Prisma.PrismaClientInitializationError(message, clientVersion, "P1001");
    expect(persistenceErrorDiagnostic(error)).toEqual({
      errorName: "PrismaClientInitializationError", errorClass: "prisma_initialization", prismaCode: "P1001", prismaClientVersion: clientVersion
    });
  });

  it("classifies Prisma validation without exposing query arguments", () => {
    expect(persistenceErrorDiagnostic(new Prisma.PrismaClientValidationError(message, { clientVersion }))).toEqual({
      errorName: "PrismaClientValidationError", errorClass: "prisma_validation", prismaClientVersion: clientVersion
    });
  });

  it.each([
    "TOKEN_ENCRYPTION_KEY is required for server-side secret handling.",
    "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.",
    "CLEANUP_STATE_ENCRYPTION_KEY is required for server-side secret handling.",
    "CLEANUP_STATE_ENCRYPTION_KEY must decode to exactly 32 bytes.",
    "Cleanup state encryption key must be exactly 32 bytes."
  ])("recognizes the existing encryption configuration error without logging its message: %s", message => {
    expect(persistenceErrorDiagnostic(new Error(message))).toEqual({ errorName: "Error", errorClass: "encryption_configuration" });
  });

  it("classifies JSON serialization/parsing failures without raw input", () => {
    expect(persistenceErrorDiagnostic(new SyntaxError(message))).toEqual({ errorName: "SyntaxError", errorClass: "serialization" });
  });

  it.each([
    Object.assign(new Error(message), { name: message, ...sensitive }),
    new TypeError(message),
    new Prisma.PrismaClientUnknownRequestError(message, { clientVersion }),
    { ...sensitive, name: "PrismaClientKnownRequestError", code: "P2002", message },
    message, null
  ])("never serializes unknown exceptions or sensitive fields (%#)", error => {
    const diagnostic = persistenceErrorDiagnostic(error);
    expect(diagnostic.errorClass).toBe("unknown");
    for (const value of Object.values(sensitive)) expect(JSON.stringify(diagnostic)).not.toContain(value);
    expect(Object.keys(diagnostic).every(key => ["errorName", "errorClass", "prismaCode", "prismaClientVersion"].includes(key))).toBe(true);
  });

  it("does not trust arbitrary code or clientVersion strings even on Prisma errors", () => {
    const error = new Prisma.PrismaClientKnownRequestError(message, { code: message, clientVersion: message, meta: sensitive });
    expect(persistenceErrorDiagnostic(error)).toEqual({ errorName: "PrismaClientKnownRequestError", errorClass: "prisma_known_request" });
  });
});
