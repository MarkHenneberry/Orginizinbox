import "server-only";
import { Prisma } from "@prisma/client";

type PersistenceErrorClass = "prisma_known_request" | "prisma_initialization" | "prisma_validation"
  | "encryption_configuration" | "serialization" | "unknown";

type PersistenceErrorDiagnostic = {
  errorName: "PrismaClientKnownRequestError" | "PrismaClientInitializationError" | "PrismaClientValidationError"
    | "PrismaClientUnknownRequestError" | "SyntaxError" | "TypeError" | "Error" | "Unknown";
  errorClass: PersistenceErrorClass;
  prismaCode?: string;
  prismaClientVersion?: string;
};

const safePrismaCode = (code: unknown) => typeof code === "string" && /^P\d{4}$/.test(code) ? code : undefined;

// Never forward exception properties wholesale, including user-controlled names or Prisma metadata.
export function persistenceErrorDiagnostic(error: unknown): PersistenceErrorDiagnostic {
  const clientVersion = (version: string) => version === Prisma.prismaVersion.client && /^\d+\.\d+\.\d+$/.test(version)
    ? { prismaClientVersion: version } : {};
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const code = safePrismaCode(error.code);
    return {
      errorName: "PrismaClientKnownRequestError",
      errorClass: code === "P2034" ? "serialization" : "prisma_known_request",
      ...(code ? { prismaCode: code } : {}),
      ...clientVersion(error.clientVersion)
    };
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    const code = safePrismaCode(error.errorCode);
    return {
      errorName: "PrismaClientInitializationError", errorClass: "prisma_initialization",
      ...(code ? { prismaCode: code } : {}), ...clientVersion(error.clientVersion)
    };
  }
  if (error instanceof Prisma.PrismaClientValidationError) {
    return { errorName: "PrismaClientValidationError", errorClass: "prisma_validation", ...clientVersion(error.clientVersion) };
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return { errorName: "PrismaClientUnknownRequestError", errorClass: "unknown", ...clientVersion(error.clientVersion) };
  }
  if (error instanceof Error && (
    /^(TOKEN_ENCRYPTION_KEY|CLEANUP_STATE_ENCRYPTION_KEY) (is required for server-side secret handling\.|must decode to exactly 32 bytes\.)$/.test(error.message) ||
    error.message === "Cleanup state encryption key must be exactly 32 bytes."
  )) {
    return { errorName: "Error", errorClass: "encryption_configuration" };
  }
  if (error instanceof SyntaxError) return { errorName: "SyntaxError", errorClass: "serialization" };
  if (error instanceof TypeError) return { errorName: "TypeError", errorClass: "unknown" };
  return { errorName: error instanceof Error ? "Error" : "Unknown", errorClass: "unknown" };
}
