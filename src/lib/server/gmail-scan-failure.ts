// Temporary diagnostic: never derive a public value from exception text.
export const gmailScanFailureCategories = [
  "imap_auth_failed", "provider_connection_failed", "durable_state_failed",
  "provider_request_failed", "cancelled", "unknown"
] as const;
export type GmailScanFailureCategory = typeof gmailScanFailureCategories[number];
export type GmailScanFailurePhase = "connection" | "provider" | "durable";

export const gmailConnectionFailureReasons = [
  "runtime_config_unavailable", "connection_lookup_failed", "connection_record_missing",
  "connection_credentials_missing", "gmail_scope_missing", "token_expired_no_refresh_token",
  "token_refresh_failed", "token_refresh_access_token_missing", "token_refresh_scope_missing",
  "access_token_decrypt_failed", "account_email_decrypt_failed", "refresh_token_decrypt_failed",
  "unknown_connection_failure"
] as const;
export type GmailConnectionFailureReason = typeof gmailConnectionFailureReasons[number];
export type GmailConnectionDiagnostic = { failureReason?: GmailConnectionFailureReason };

export function safeGmailConnectionFailure(value: unknown): GmailConnectionFailureReason {
  return gmailConnectionFailureReasons.includes(value as GmailConnectionFailureReason)
    ? value as GmailConnectionFailureReason : "unknown_connection_failure";
}

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
