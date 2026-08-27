import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("google oauth state lifecycle", () => {
  it("keeps app session and oauth state cookies distinct with localhost-safe options", () => {
    const session = readFileSync("src/lib/server/session.ts", "utf8");

    expect(session).toMatch(/SESSION_COOKIE = "organizinbox_session"/);
    expect(session).toMatch(/OAUTH_STATE_COOKIE = "organizinbox_oauth_state"/);
    expect(session).toMatch(/export function appSessionCookieOptions/);
    expect(session).toMatch(/export function oauthStateCookieOptions/);
    expect(session).toMatch(/httpOnly:\s*true/);
    expect(session).toMatch(/sameSite:\s*"lax"/);
    expect(session).toMatch(/secure:\s*process\.env\.NODE_ENV === "production"/);
    expect(session).toMatch(/path:\s*"\/"/);
    expect(session).toMatch(/maxAge:\s*oauthStateTtlMs \/ 1000/);
  });

  it("creates fresh oauth state, consumes it once, and rejects invalid state cases", () => {
    const session = readFileSync("src/lib/server/session.ts", "utf8");

    expect(session).toMatch(/randomBytes\(24\)\.toString\("base64url"\)/);
    expect(session).toMatch(/cookieStore\.set\(OAUTH_STATE_COOKIE[\s\S]+oauthStateCookieOptions\(\)/);
    expect(session).toMatch(/cookieStore\.set\(OAUTH_STATE_COOKIE,\s*"",\s*expiredCookieOptions\(\)\)/);
    expect(session).toMatch(/Missing OAuth state\./);
    expect(session).toMatch(/Missing OAuth state cookie\./);
    expect(session).toMatch(/Invalid OAuth state cookie\./);
    expect(session).toMatch(/OAuth state expired\./);
    expect(session).toMatch(/OAuth state mismatch\./);
  });

  it("makes oauth start dynamic, no-store, and fresh for reconnect without requiring an app session", () => {
    const startRoute = readFileSync("app/api/oauth/google/start/route.ts", "utf8");

    expect(startRoute).toMatch(/dynamic = "force-dynamic"/);
    expect(startRoute).toMatch(/revalidate = 0/);
    expect(startRoute).toMatch(/createOAuthState\("\/app\/scan"\)/);
    expect(startRoute).toMatch(/Cache-Control",\s*"no-store, max-age=0"/);
    expect(startRoute).not.toMatch(/getCurrentProviderConnection/);
    expect(startRoute).not.toMatch(/mode === "connected"[\s\S]+redirect/);
  });

  it("validates oauth state before token exchange and redirects state failures to retry UX", () => {
    const callback = readFileSync("app/api/oauth/google/callback/route.ts", "utf8");
    const errorPage = readFileSync("app/connect/google/error/page.tsx", "utf8");

    expect(callback).toMatch(/stateResult = await consumeOAuthState[\s\S]+tokens = await exchangeGoogleCode/);
    expect(callback).toMatch(/dynamic = "force-dynamic"/);
    expect(callback).toMatch(/revalidate = 0/);
    expect(callback).toMatch(/Cache-Control",\s*"no-store, max-age=0"/);
    expect(callback).toMatch(/tokens = await exchangeGoogleCode[\s\S]+verifyGoogleTokenScopes\(tokens, profile\?\.email\)[\s\S]+upsertGoogleConnection/);
    expect(callback).toMatch(/missing_state_cookie/);
    expect(callback).toMatch(/state_mismatch/);
    expect(callback).toMatch(/state_expired/);
    expect(callback).not.toMatch(/NextResponse\.json\(\{ error: stateResult\.reason/);
    expect(errorPage).toMatch(/Gmail didn't finish connecting/);
    expect(errorPage).toMatch(/We couldn't connect Gmail/);
    expect(errorPage).toMatch(/Try connecting Gmail again/);
    expect(errorPage).not.toMatch(/Gmail IMAP permission was not granted/);
    expect(errorPage).toMatch(/action="\/api\/oauth\/google\/start"/);
    expect(errorPage).toMatch(/scope_verification_failed/);
    expect(errorPage).toMatch(/token_exchange_failed/);
    expect(errorPage).toMatch(/Development error/);
    expect(errorPage).toMatch(/getSafeOAuthDevelopmentErrorCode/);
  });

  it("disconnect clears provider session, transient report, cleanup jobs, and stale oauth state", () => {
    const disconnect = readFileSync("src/lib/server/disconnect.ts", "utf8");

    expect(disconnect).toMatch(/clearOAuthStateCookie/);
    expect(disconnect).toMatch(/clearSessionCookie/);
    expect(disconnect).toMatch(/clearLiveScan/);
    expect(disconnect).toMatch(/clearGmailCleanupJobsForUser/);
    expect(disconnect).toMatch(/disconnectedAt:\s*new Date\(\)/);
  });

  it("uses full browser navigation for oauth start instead of Next Link prefetch", () => {
    const files = [
      "app/connect/google/page.tsx",
      "app/connect/google/error/page.tsx",
      "app/app/page.tsx",
      "app/app/scan/page.tsx",
      "app/app/dev/gmail-benchmark/page.tsx"
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/<Link[^>]+href="\/api\/oauth\/google\/start"/);
    }
    for (const file of files) {
    expect(readFileSync(file, "utf8")).toMatch(/action="\/api\/oauth\/google\/start"/);
    }
  });
});
