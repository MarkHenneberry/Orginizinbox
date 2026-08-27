import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/components/marketing/Header", () => ({ Header: () => null }));
vi.mock("@/components/marketing/Footer", () => ({ Footer: () => null }));
vi.mock("@/components/product/ContextBackAction", () => ({ ContextBackAction: () => null }));

import GoogleOAuthErrorPage from "../app/connect/google/error/page";
import {
  createOAuthCallbackDiagnostic,
  getSafeOAuthDevelopmentErrorCode,
  logOAuthCallbackDiagnostic,
  safeOAuthDevelopmentErrorCodes
} from "@/lib/server/oauth-callback-diagnostics";

describe("safe OAuth callback diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses a strict allowlist for development error codes", () => {
    expect(getSafeOAuthDevelopmentErrorCode("scope_verification_failed", "development")).toBe("TOKEN_SCOPE_VERIFICATION_FAILED");
    expect(getSafeOAuthDevelopmentErrorCode("token_exchange_failed", "development")).toBe("TOKEN_EXCHANGE_FAILED");
    expect(getSafeOAuthDevelopmentErrorCode("unknown-provider-text", "development")).toBe("CALLBACK_FAILED");
    expect(Object.values(safeOAuthDevelopmentErrorCodes)).not.toContain("unknown-provider-text");
  });

  it("renders the safe diagnostic code in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const page = await GoogleOAuthErrorPage({ searchParams: Promise.resolve({ reason: "scope_verification_failed" }) });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Development error:");
    expect(html).toContain("TOKEN_SCOPE_VERIFICATION_FAILED");
    expect(html).not.toContain("access_token");
    expect(html).not.toContain("refresh_token");
  });

  it("does not render a diagnostic code in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const page = await GoogleOAuthErrorPage({ searchParams: Promise.resolve({ reason: "scope_verification_failed" }) });
    const html = renderToStaticMarkup(page);

    expect(html).not.toContain("Development error:");
    expect(html).not.toContain("TOKEN_SCOPE_VERIFICATION_FAILED");
  });

  it("logs only the structured safe lifecycle record in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const diagnostic = createOAuthCallbackDiagnostic();
    diagnostic.state_validation = "success";
    diagnostic.token_exchange = "success";
    diagnostic.final_result = "success";

    logOAuthCallbackDiagnostic(diagnostic);

    expect(diagnostic.attempt_id).toMatch(/^[a-f0-9]{16}$/);
    expect(info).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(info.mock.calls);
    for (const forbidden of ["access-token", "refresh-token", "authorization-code", "oauth-state", "user@example.test", "user-1"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not emit callback diagnostics in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logOAuthCallbackDiagnostic(createOAuthCallbackDiagnostic());

    expect(info).not.toHaveBeenCalled();
  });
});

