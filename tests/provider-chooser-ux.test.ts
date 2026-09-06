import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isMicrosoftOAuthDevelopmentUiEnabled } from "@/lib/providers/microsoft/development-access";

function read(path: string) {
  return readFileSync(path, "utf8");
}

describe("provider chooser onboarding", () => {
  it("routes generic public cleanup entry through the provider chooser", () => {
    const appState = read("src/lib/server/app-state.ts");
    expect(appState).toMatch(/intent === "gmail"[\s\S]+href: "\/connect\/google"[\s\S]+href: "\/connect", label: "Clean my inbox"/);
  });

  it("offers Gmail and gates Microsoft on the chooser", () => {
    const chooser = read("app/connect/page.tsx");
    expect(chooser).toMatch(/Connect your inbox/);
    expect(chooser).toMatch(/href="\/connect\/google"[\s\S]+Continue with Google/);
    expect(chooser).toMatch(/microsoftDevelopmentEnabled[\s\S]+href="\/connect\/microsoft"[\s\S]+Continue with Microsoft/);
    expect(chooser).toMatch(/Coming soon/);
    expect(chooser).toMatch(/isMicrosoftOAuthDevelopmentUiEnabled/);
    expect(isMicrosoftOAuthDevelopmentUiEnabled("development", true)).toBe(true);
    expect(isMicrosoftOAuthDevelopmentUiEnabled("development", false)).toBe(false);
    expect(isMicrosoftOAuthDevelopmentUiEnabled("production", true)).toBe(false);
  });

  it("exposes a development Outlook CTA without claiming mailbox support", () => {
    const appState = read("src/lib/server/app-state.ts");
    const marketing = read("src/components/product/MarketingInfoContent.tsx");
    expect(appState).toMatch(/href: "\/connect\/microsoft", label: "Connect Outlook"/);
    expect(marketing).toMatch(/Microsoft connection is available for development testing/);
    expect(marketing).toMatch(/Read-only Outlook scanning is available for development testing/);
  });

  it("continues Microsoft OAuth success into the read-only scan state", () => {
    const callback = read("app/api/oauth/microsoft/callback/route.ts");
    const connect = read("app/connect/microsoft/page.tsx");
    const appHome = read("app/app/page.tsx");
    expect(callback).toMatch(/\/app\/account/);
    expect(callback).not.toMatch(/gmail-scan|Graph|messages/);
    expect(connect).toMatch(/Microsoft connected/);
    expect(connect).toMatch(/Scan Outlook inbox/);
    expect(connect).toMatch(/DisconnectMicrosoftConfirmation/);
    expect(appHome).toMatch(/Scan Outlook inbox/);
    expect(appHome).toMatch(/Outlook cleanup is not available yet/);
  });

  it("keeps Gmail on its existing OAuth start route", () => {
    const googleConnect = read("app/connect/google/page.tsx");
    expect(googleConnect).toMatch(/action="\/api\/oauth\/google\/start"/);
    expect(googleConnect).toMatch(/You do not need to reconnect Gmail/);
  });
});
