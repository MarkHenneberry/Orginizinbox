import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const oauthBoundary = vi.hoisted(() => ({
  runtime: { microsoftAvailable: false },
  configuration: vi.fn(), state: vi.fn(async () => "test-state"),
  consume: vi.fn(async () => ({ ok: false })),
  authorizationUrl: vi.fn(() => "https://example.test/authorize")
}));
vi.mock("@/lib/config", () => ({ runtimeConfig: oauthBoundary.runtime,
  requireMicrosoftOAuthConfig: oauthBoundary.configuration, ConfigurationError: class extends Error {} }));
vi.mock("@/lib/server/session", () => ({ createOAuthState: oauthBoundary.state, consumeOAuthState: oauthBoundary.consume,
  getSession: vi.fn(), setSessionCookie: vi.fn() }));
vi.mock("@/lib/server/microsoft-oauth", () => ({
  buildMicrosoftAuthorizationUrl: oauthBoundary.authorizationUrl,
  createMicrosoftOAuthAttemptSecrets: () => ({ codeVerifier: "verifier", codeChallenge: "challenge", nonce: "nonce" }),
  exchangeMicrosoftCode: vi.fn(), saveMicrosoftImapCredentials: vi.fn(), upsertMicrosoftConnection: vi.fn(),
  verifyMicrosoftImapTokenResponse: vi.fn(), verifyMicrosoftTokenResponse: vi.fn(),
  MicrosoftImapScopeNotGrantedError: class extends Error {}, MicrosoftIdentityValidationError: class extends Error {},
  MicrosoftRefreshTokenMissingError: class extends Error {}, MicrosoftScopeNotGrantedError: class extends Error {},
  MicrosoftTokenResponseError: class extends Error {}
}));

describe("Microsoft OAuth product boundaries", () => {
  it("uses resolved provider availability and full browser navigation without prefetch", async () => {
    const { GET: start } = await import("../app/api/oauth/microsoft/start/route");
    const { GET: callback } = await import("../app/api/oauth/microsoft/callback/route");
    const connect = readFileSync("app/connect/microsoft/page.tsx", "utf8");
    const request = new NextRequest("https://example.test/api/oauth/microsoft/callback");
    try {
      for (const mode of ["development", "production"]) {
        vi.stubEnv("NODE_ENV", mode);
        vi.clearAllMocks();
        oauthBoundary.runtime.microsoftAvailable = false;
        expect((await start()).status).toBe(404);
        expect((await callback(request)).status).toBe(404);
        expect(oauthBoundary.state).not.toHaveBeenCalled();
        expect(oauthBoundary.consume).not.toHaveBeenCalled();
        oauthBoundary.runtime.microsoftAvailable = true;
        expect((await start()).headers.get("location")).toBe("https://example.test/authorize");
        expect(oauthBoundary.configuration).toHaveBeenCalledOnce();
        expect(oauthBoundary.state).toHaveBeenCalledWith("/app/account", {
          provider: "microsoft", codeVerifier: "verifier", nonce: "nonce", microsoftFlow: "graph"
        });
        expect(oauthBoundary.authorizationUrl).toHaveBeenCalledWith({ state: "test-state", codeChallenge: "challenge", nonce: "nonce", flow: "graph" });
        expect((await callback(request)).headers.get("location")).toContain("reason=state_invalid");
        expect(oauthBoundary.consume).toHaveBeenCalledWith(null, "microsoft");
      }
    } finally { vi.unstubAllEnvs(); oauthBoundary.runtime.microsoftAvailable = false; }
    expect(connect).toMatch(/<form action="\/api\/oauth\/microsoft\/start"[\s\S]+method="get">/);
    expect(connect).not.toMatch(/<Link[^>]+href="\/api\/oauth\/microsoft\/start"/);
  });

  it("keeps Outlook IMAP consent separately development-gated and scan-only", () => {
    const start = readFileSync("app/api/oauth/microsoft/imap/start/route.ts", "utf8");
    const scanner = readFileSync("src/lib/providers/microsoft/imap-provider.ts", "utf8");
    expect(start).toMatch(/NODE_ENV === "production"[\s\S]+outlookImapBenchmarkDevEnabled/);
    expect(start).toMatch(/microsoftFlow: "imap"/);
    expect(scanner).toMatch(/mailboxOpen\(folder\.path, \{ readOnly: true \}\)/);
    expect(scanner).toMatch(/client\.fetch\(`\$\{start\}:\$\{end\}`/);
    expect(scanner).not.toMatch(/messageMove|messageDelete|mailboxCreate|mailboxDelete|mailboxRename|append\(/);
    expect(scanner).not.toMatch(/prisma|CleanupJob|batchJson|\/move/);
  });

  it("renders Microsoft read-only scan state without exposing Outlook cleanup controls", () => {
    const appHome = readFileSync("app/app/page.tsx", "utf8");
    const account = readFileSync("app/app/account/page.tsx", "utf8");
    const scan = readFileSync("app/app/scan/page.tsx", "utf8");
    const layout = readFileSync("app/app/layout.tsx", "utf8");
    expect(`${appHome}\n${account}\n${layout}`).toMatch(/Microsoft[\s\S]+connected/i);
    expect(appHome).toMatch(/Scan Outlook inbox/);
    expect(appHome).toMatch(/Outlook cleanup is not available yet/);
    expect(account).toMatch(/DisconnectMicrosoftConfirmation/);
    expect(scan).toMatch(/connection\.provider === "microsoft"[\s\S]+OutlookScanClient/);
    expect(scan).toMatch(/connection\.provider === "gmail"[\s\S]+GmailScanClient/);
  });

  it("keeps mutation out of OAuth and limits the provider to reversible move operations", () => {
    const oauth = readFileSync("src/lib/server/microsoft-oauth.ts", "utf8");
    const provider = readFileSync("src/lib/providers/microsoft/provider.ts", "utf8");
    const routes = `${readFileSync("app/api/oauth/microsoft/start/route.ts", "utf8")}\n${readFileSync("app/api/oauth/microsoft/callback/route.ts", "utf8")}`;
    expect(`${oauth}\n${routes}`).not.toMatch(/graph\.microsoft\.com\/v1\.0|\/me\/messages|mailFolders|permanentDelete|sendMail|attachments/);
    expect(provider).toMatch(/scanMetadata/);
    expect(provider).toMatch(/\/me\/messages\/\$\{encodeURIComponent\(messageId\)\}\/move/);
    expect(provider).not.toMatch(/permanentDelete|sendMail|createReply|createForward|\/attachments\b/);
  });
});
