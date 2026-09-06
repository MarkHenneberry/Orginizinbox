import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Microsoft OAuth product boundaries", () => {
  it("keeps OAuth development-gated and uses full browser navigation without prefetch", () => {
    const start = readFileSync("app/api/oauth/microsoft/start/route.ts", "utf8");
    const callback = readFileSync("app/api/oauth/microsoft/callback/route.ts", "utf8");
    const connect = readFileSync("app/connect/microsoft/page.tsx", "utf8");
    expect(start).toMatch(/NODE_ENV === "production"[\s\S]+microsoftOAuthDevEnabled/);
    expect(callback).toMatch(/NODE_ENV === "production"[\s\S]+microsoftOAuthDevEnabled/);
    expect(start).toMatch(/createOAuthState\("\/app\/account"[\s\S]+provider: "microsoft"[\s\S]+codeVerifier[\s\S]+nonce/);
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
