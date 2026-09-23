import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/diagnostics/gmail-readiness/route";
import { productionProviderChecks, resolveProductionProviders } from "@/lib/server/production-config";

const configured = {
  GMAIL_PRODUCTION_ENABLED: "true",
  NEXT_PUBLIC_APP_URL: "https://diagnostic.example.test",
  DATABASE_URL: "postgresql://private-user:private-password@private-host/private-db",
  TOKEN_ENCRYPTION_KEY: "t".repeat(32),
  CLEANUP_STATE_ENCRYPTION_KEY: "s".repeat(32),
  CRON_SECRET: "private-test-cron-secret",
  GOOGLE_CLIENT_ID: "private-client-id",
  GOOGLE_CLIENT_SECRET: "private-client-secret",
  GOOGLE_REDIRECT_URI: "https://diagnostic.example.test/api/oauth/google/callback"
};
function request(authorization?: string) {
  return new Request("https://diagnostic.example.test/api/diagnostics/gmail-readiness", {
    headers: authorization === undefined ? {} : { Authorization: authorization }
  });
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  for (const [name, value] of Object.entries(configured)) vi.stubEnv(name, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("temporary authenticated Gmail readiness diagnostic", () => {
  it.each([undefined, "Bearer wrong", `Bearer ${"x".repeat(configured.CRON_SECRET.length)}`, configured.CRON_SECRET])(
    "rejects unauthorized requests without disclosing checks (%s)", async (authorization) => {
      const response = await GET(request(authorization));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ authorized: false });
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  );

  it.each([undefined, "", "   "])("fails closed without a configured secret", async (secret) => {
    vi.stubEnv("CRON_SECRET", secret);
    const response = await GET(request(`Bearer ${configured.CRON_SECRET}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ authorized: false });
  });

  it("returns only the exact allowlisted boolean checks and no values", async () => {
    const response = await GET(request(`Bearer ${configured.CRON_SECRET}`));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ authorized: true, gmailAvailable: true,
      checks: Object.fromEntries(Object.keys(configured).map((name) => [name, true])), failedChecks: [] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    for (const value of Object.values(configured).filter((value) => value !== "true")) {
      expect(JSON.stringify(body)).not.toContain(value);
    }
  });

  it.each(Object.keys(configured))("uses the real gate for missing %s", (name) => {
    const input = { ...configured, [name]: undefined };
    const checks = productionProviderChecks(input).gmail;
    expect(checks[name as keyof typeof checks]).toBe(false);
    expect(Object.values(checks).every(Boolean)).toBe(resolveProductionProviders(input).gmail);
    expect(resolveProductionProviders(input).gmail).toBe(false);
  });

  it("reports invalid database/key/callback names without leaking their values", async () => {
    vi.stubEnv("DATABASE_URL", "invalid-private-db-value");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "private-invalid-key");
    vi.stubEnv("GOOGLE_REDIRECT_URI", "https://wrong-host.test/wrong?token=private-token");
    const response = await GET(request(`Bearer ${configured.CRON_SECRET}`));
    const body = await response.json();
    expect(body.gmailAvailable).toBe(resolveProductionProviders(process.env).gmail);
    expect(body.failedChecks).toEqual(["DATABASE_URL", "TOKEN_ENCRYPTION_KEY", "GOOGLE_REDIRECT_URI"]);
    expect(Object.values(body.checks).every((value) => typeof value === "boolean")).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/private-|wrong-host|https:|postgresql:|length|stack/);
  });

  it("never serializes unexpected exceptions", async () => {
    vi.spyOn(Object, "entries").mockImplementationOnce(() => { throw new Error("private-raw-exception"); });
    const response = await GET(request(`Bearer ${configured.CRON_SECRET}`));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ authorized: true, diagnosticAvailable: false });
  });
});
