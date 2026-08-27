import { randomBytes } from "node:crypto";

export const safeOAuthDevelopmentErrorCodes = {
  oauth_denied: "OAUTH_DENIED",
  gmail_scope: "GMAIL_SCOPE_MISSING",
  gmail_capability_denied: "GMAIL_IMAP_AUTHENTICATION_DENIED",
  missing_state_cookie: "OAUTH_STATE_COOKIE_MISSING",
  missing_state: "OAUTH_STATE_MISSING",
  state_mismatch: "OAUTH_STATE_MISMATCH",
  state_expired: "OAUTH_STATE_EXPIRED",
  state_invalid: "OAUTH_STATE_INVALID",
  missing_code: "AUTHORIZATION_CODE_MISSING",
  scope_verification_failed: "TOKEN_SCOPE_VERIFICATION_FAILED",
  token_exchange_failed: "TOKEN_EXCHANGE_FAILED",
  userinfo_failed: "USERINFO_FAILED",
  provider_connection_save_failed: "PROVIDER_CONNECTION_SAVE_FAILED",
  session_creation_failed: "SESSION_CREATION_FAILED",
  callback_failed: "CALLBACK_FAILED"
} as const;

export type SafeOAuthDevelopmentErrorCode = (typeof safeOAuthDevelopmentErrorCodes)[keyof typeof safeOAuthDevelopmentErrorCodes];
export type SafeOAuthErrorReason = keyof typeof safeOAuthDevelopmentErrorCodes;
export type SafeFallbackErrorClass = "NONE" | "AUTHENTICATION_DENIED" | "TIMEOUT" | "NETWORK" | "THROTTLED" | "PROTOCOL" | "UNKNOWN";

type StageResult = "success" | "failure" | "not_started";

export type OAuthCallbackDiagnostic = {
  attempt_id: string;
  state_validation: StageResult;
  token_exchange: StageResult;
  token_scope_field_present: boolean | "not_started";
  explicit_scope_check: "present" | "missing" | "not_applicable";
  fallback_scope_verification_started: boolean;
  fallback_scope_verification_result: "success" | "missing" | "error" | "not_used";
  fallback_attempts: 0 | 1 | 2;
  fallback_http_status: number | "not_applicable";
  fallback_error_class: SafeFallbackErrorClass;
  fallback_timeout: boolean;
  userinfo: StageResult;
  provider_connection_save: StageResult;
  session_creation: StageResult;
  final_result: "success" | SafeOAuthDevelopmentErrorCode;
};

export function createOAuthCallbackDiagnostic(): OAuthCallbackDiagnostic {
  return {
    attempt_id: randomBytes(8).toString("hex"),
    state_validation: "not_started",
    token_exchange: "not_started",
    token_scope_field_present: "not_started",
    explicit_scope_check: "not_applicable",
    fallback_scope_verification_started: false,
    fallback_scope_verification_result: "not_used",
    fallback_attempts: 0,
    fallback_http_status: "not_applicable",
    fallback_error_class: "NONE",
    fallback_timeout: false,
    userinfo: "not_started",
    provider_connection_save: "not_started",
    session_creation: "not_started",
    final_result: "CALLBACK_FAILED"
  };
}

export function getSafeOAuthDevelopmentErrorCode(reason: string, nodeEnv = process.env.NODE_ENV): SafeOAuthDevelopmentErrorCode | null {
  if (nodeEnv === "production") return null;
  return Object.prototype.hasOwnProperty.call(safeOAuthDevelopmentErrorCodes, reason)
    ? safeOAuthDevelopmentErrorCodes[reason as SafeOAuthErrorReason]
    : safeOAuthDevelopmentErrorCodes.callback_failed;
}

export function logOAuthCallbackDiagnostic(diagnostic: OAuthCallbackDiagnostic) {
  if (process.env.NODE_ENV !== "development") return;
  console.info(`OAuth callback ${diagnostic.attempt_id}`, diagnostic);
}

