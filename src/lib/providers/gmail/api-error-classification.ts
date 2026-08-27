export const gmailProviderErrorReasons = [
  "GMAIL_INVALID_QUERY",
  "GMAIL_AUTHENTICATION_FAILED",
  "GMAIL_PERMISSION_DENIED",
  "GMAIL_DOMAIN_POLICY",
  "GMAIL_USER_RATE_LIMITED",
  "GMAIL_PROJECT_RATE_LIMITED",
  "GMAIL_DAILY_LIMIT",
  "GMAIL_TOO_MANY_REQUESTS",
  "GMAIL_PROVIDER_5XX",
  "GMAIL_NETWORK_ERROR",
  "GMAIL_TIMEOUT",
  "GMAIL_NOT_FOUND",
  "GMAIL_RESPONSE_INVALID",
  "GMAIL_UNKNOWN_PROVIDER_ERROR"
] as const;

export type GmailProviderErrorReason = (typeof gmailProviderErrorReasons)[number];
export type GmailProviderErrorCounts = Record<GmailProviderErrorReason, number>;

export type GmailProviderFailure = {
  reason: GmailProviderErrorReason;
  status?: number;
  retryable: boolean;
};

const google403Reasons = [
  "userRateLimitExceeded",
  "rateLimitExceeded",
  "dailyLimitExceeded",
  "domainPolicy"
] as const;
type Google403Reason = (typeof google403Reasons)[number];

export async function classifyGmailErrorResponse(response: Response): Promise<GmailProviderFailure> {
  const status = response.status;
  return status === 403 ? classifyForbiddenResponse(response) : classifyGmailErrorStatus(status);
}

export function classifyGmailErrorStatus(status: number): GmailProviderFailure {
  if (status === 400) return failure("GMAIL_INVALID_QUERY", status, false);
  if (status === 401) return failure("GMAIL_AUTHENTICATION_FAILED", status, false);
  if (status === 403) return failure("GMAIL_PERMISSION_DENIED", status, false);
  if (status === 404) return failure("GMAIL_NOT_FOUND", status, false);
  if (status === 408) return failure("GMAIL_TIMEOUT", status, true);
  if (status === 429) return failure("GMAIL_TOO_MANY_REQUESTS", status, true);
  if (status >= 500 && status <= 599) return failure("GMAIL_PROVIDER_5XX", status, true);
  return failure("GMAIL_UNKNOWN_PROVIDER_ERROR", status, false);
}

export function classifyGmailTransportError(error: unknown): GmailProviderFailure {
  if (isAbortError(error)) return failure("GMAIL_TIMEOUT", undefined, true);
  if (error instanceof TypeError) return failure("GMAIL_NETWORK_ERROR", undefined, true);
  return failure("GMAIL_UNKNOWN_PROVIDER_ERROR", undefined, false);
}

export function createGmailProviderErrorCounts(): GmailProviderErrorCounts {
  return Object.fromEntries(gmailProviderErrorReasons.map((reason) => [reason, 0])) as GmailProviderErrorCounts;
}

export function inferGmailProviderErrorReason(
  status: number | undefined,
  transient: boolean
): GmailProviderErrorReason {
  if (status === 400) return "GMAIL_INVALID_QUERY";
  if (status === 401) return "GMAIL_AUTHENTICATION_FAILED";
  if (status === 403) return "GMAIL_PERMISSION_DENIED";
  if (status === 404) return "GMAIL_NOT_FOUND";
  if (status === 408) return "GMAIL_TIMEOUT";
  if (status === 429) return "GMAIL_TOO_MANY_REQUESTS";
  if (typeof status === "number" && status >= 500) return "GMAIL_PROVIDER_5XX";
  return transient ? "GMAIL_NETWORK_ERROR" : "GMAIL_UNKNOWN_PROVIDER_ERROR";
}

async function classifyForbiddenResponse(response: Response): Promise<GmailProviderFailure> {
  const reasons = await readGoogleReasons(response);
  if (reasons.has("userRateLimitExceeded")) {
    return failure("GMAIL_USER_RATE_LIMITED", 403, true);
  }
  if (reasons.has("rateLimitExceeded")) {
    return failure("GMAIL_PROJECT_RATE_LIMITED", 403, true);
  }
  if (reasons.has("dailyLimitExceeded")) {
    return failure("GMAIL_DAILY_LIMIT", 403, false);
  }
  if (reasons.has("domainPolicy")) {
    return failure("GMAIL_DOMAIN_POLICY", 403, false);
  }
  return failure("GMAIL_PERMISSION_DENIED", 403, false);
}

async function readGoogleReasons(response: Response) {
  const reasons = new Set<Google403Reason>();
  try {
    const value = (await response.json()) as unknown;
    if (!isRecord(value) || !isRecord(value.error) || !Array.isArray(value.error.errors)) return reasons;
    for (const item of value.error.errors) {
      if (isRecord(item) && isGoogle403Reason(item.reason)) reasons.add(item.reason);
    }
  } catch {
    // The status-only fallback is intentionally sufficient when Google returns malformed JSON.
  }
  return reasons;
}

function isGoogle403Reason(value: unknown): value is Google403Reason {
  return typeof value === "string" && google403Reasons.some((reason) => reason === value);
}

function failure(
  reason: GmailProviderErrorReason,
  status: number | undefined,
  retryable: boolean
): GmailProviderFailure {
  return { reason, status, retryable };
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
