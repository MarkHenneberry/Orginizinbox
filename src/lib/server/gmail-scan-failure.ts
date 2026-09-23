// Temporary diagnostic: never derive a public value from exception text.
export const gmailScanFailureCategories = [
  "imap_auth_failed", "provider_connection_failed", "durable_state_failed",
  "provider_request_failed", "cancelled", "unknown"
] as const;
export type GmailScanFailureCategory = typeof gmailScanFailureCategories[number];
export type GmailScanFailurePhase = "connection" | "provider" | "durable";

export function classifyGmailScanFailure(error: unknown, phase: GmailScanFailurePhase): GmailScanFailureCategory {
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  if (phase === "durable") return "durable_state_failed";
  if (error && typeof error === "object" && "authenticationFailed" in error && error.authenticationFailed === true) {
    return "imap_auth_failed";
  }
  if (phase === "connection") return "provider_connection_failed";
  if (error && typeof error === "object" && "code" in error &&
    ["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "ECONNRESET"].includes(String(error.code))) {
    return "provider_connection_failed";
  }
  return "provider_request_failed";
}

export function safeGmailScanFailure(value: unknown): GmailScanFailureCategory {
  return gmailScanFailureCategories.includes(value as GmailScanFailureCategory)
    ? value as GmailScanFailureCategory : "unknown";
}
