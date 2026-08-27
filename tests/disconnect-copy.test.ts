import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("final Gmail disconnect product copy", () => {
  it("describes normal Disconnect as local credential destruction without claiming Google-side removal", () => {
    const confirmation = readFileSync("src/components/product/DisconnectGmailConfirmation.tsx", "utf8");
    const privacy = readFileSync("src/components/product/PrivacyContent.tsx", "utf8");
    const dataAccess = readFileSync("src/components/product/DataAccessContent.tsx", "utf8");
    const security = readFileSync("src/lib/marketing-pages.ts", "utf8");

    expect(confirmation).toContain("saved Gmail access");
    expect(confirmation).not.toMatch(/Google Account|connected apps|authorization/);
    for (const source of [privacy, dataAccess, security]) {
      expect(source).toMatch(/Disconnect(?: Gmail)? destroy/);
      expect(source).toMatch(/separate(?: confirmed)? action/);
    }
  });

  it("describes the broader Google action and provides current connected-app guidance after local disconnect", () => {
    const account = readFileSync("app/app/account/page.tsx", "utf8");
    const help = readFileSync("app/app/help/page.tsx", "utf8");
    const confirmation = readFileSync("src/components/product/RemoveGoogleAuthorizationConfirmation.tsx", "utf8");

    expect(confirmation).toContain("asks Google to remove Organizinbox from your connected apps");
    expect(confirmation).toContain("Google may take a short time");
    expect(account).toContain("Also remove Organizinbox from the apps connected to your Google Account");
    expect(account).toContain("https://myaccount.google.com/connections");
    expect(help).toContain("https://myaccount.google.com/connections");
    expect(account).toContain("opens in a new tab");
    expect(help).toContain("opens in a new tab");
  });

  it("removes every artifact that existed only for the local-disconnect experiment", () => {
    const config = readFileSync("src/lib/config.ts", "utf8");
    const envExample = readFileSync(".env.example", "utf8");
    const account = readFileSync("app/app/account/page.tsx", "utf8");

    expect(`${config}\n${envExample}\n${account}`).not.toMatch(
      /GMAIL_LOCAL_DISCONNECT_TEST_ENABLED|Dev: Disconnect locally|isGmailLocalDisconnectTestEnabled|showLocalDisconnectTest/
    );
    expect(existsSync("app/api/dev/gmail-local-disconnect/route.ts")).toBe(false);
    expect(existsSync("app/api/dev/gmail-disconnect/route.ts")).toBe(false);
  });
});
