import { describe, expect, it } from "vitest";
import {
  classifyGmailErrorResponse,
  classifyGmailTransportError
} from "@/lib/providers/gmail/api-error-classification";

function googleError(status: number, reason?: string, message = "provider detail must be discarded") {
  return new Response(
    JSON.stringify({
      error: {
        code: status,
        message,
        errors: reason ? [{ reason, message }] : []
      }
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

describe("safe Gmail provider response classification", () => {
  it.each([
    [400, undefined, "GMAIL_INVALID_QUERY", false],
    [401, undefined, "GMAIL_AUTHENTICATION_FAILED", false],
    [403, undefined, "GMAIL_PERMISSION_DENIED", false],
    [403, "domainPolicy", "GMAIL_DOMAIN_POLICY", false],
    [403, "dailyLimitExceeded", "GMAIL_DAILY_LIMIT", false],
    [403, "rateLimitExceeded", "GMAIL_PROJECT_RATE_LIMITED", true],
    [403, "userRateLimitExceeded", "GMAIL_USER_RATE_LIMITED", true],
    [404, undefined, "GMAIL_NOT_FOUND", false],
    [408, undefined, "GMAIL_TIMEOUT", true],
    [429, undefined, "GMAIL_TOO_MANY_REQUESTS", true],
    [500, undefined, "GMAIL_PROVIDER_5XX", true],
    [502, undefined, "GMAIL_PROVIDER_5XX", true],
    [503, undefined, "GMAIL_PROVIDER_5XX", true],
    [504, undefined, "GMAIL_PROVIDER_5XX", true],
    [418, undefined, "GMAIL_UNKNOWN_PROVIDER_ERROR", false]
  ])("maps HTTP %i and reason %s to %s", async (status, reason, expectedReason, retryable) => {
    await expect(classifyGmailErrorResponse(googleError(status, reason))).resolves.toEqual({
      reason: expectedReason,
      status,
      retryable
    });
  });

  it("falls back to generic permission denial for malformed or unrecognized 403 bodies", async () => {
    const malformed = new Response("not json", { status: 403 });
    const unrecognized = googleError(403, "forbiddenForSecretMailbox");

    await expect(classifyGmailErrorResponse(malformed)).resolves.toMatchObject({
      reason: "GMAIL_PERMISSION_DENIED",
      retryable: false
    });
    await expect(classifyGmailErrorResponse(unrecognized)).resolves.toMatchObject({
      reason: "GMAIL_PERMISSION_DENIED",
      retryable: false
    });
  });

  it("returns only allowlisted fields and discards provider messages", async () => {
    const secret = "raw provider body must never survive";
    const result = await classifyGmailErrorResponse(googleError(403, "domainPolicy", secret));

    expect(result).toEqual({ reason: "GMAIL_DOMAIN_POLICY", status: 403, retryable: false });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("safe Gmail transport classification", () => {
  it("distinguishes timeout, network, and unknown failures", () => {
    expect(classifyGmailTransportError(new DOMException("secret timeout", "AbortError"))).toEqual({
      reason: "GMAIL_TIMEOUT",
      status: undefined,
      retryable: true
    });
    expect(classifyGmailTransportError(new TypeError("secret network detail"))).toEqual({
      reason: "GMAIL_NETWORK_ERROR",
      status: undefined,
      retryable: true
    });
    expect(classifyGmailTransportError(new Error("secret unknown detail"))).toEqual({
      reason: "GMAIL_UNKNOWN_PROVIDER_ERROR",
      status: undefined,
      retryable: false
    });
  });
});
