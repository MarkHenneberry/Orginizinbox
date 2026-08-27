import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("authenticated app navigation", () => {
  it("keeps report-specific tabs out of the global app header and includes stable shell links", () => {
    const layout = readFileSync("app/app/layout.tsx", "utf8");
    const headerSection = layout.slice(layout.indexOf("<header"), layout.indexOf("</header>"));

    expect(headerSection).toMatch(/Organizinbox/);
    expect(headerSection).toMatch(/Help/);
    expect(headerSection).toMatch(/Account/);
    expect(layout).toMatch(/getCurrentProviderConnection/);
    expect(layout).not.toMatch(/brandHref/);
    expect(headerSection).toMatch(/href="\/"/);
    expect(headerSection).toMatch(/href="\/app\/help"/);
    expect(headerSection).toMatch(/href="\/app\/account"/);
    expect(headerSection).not.toMatch(/Senders|Categories|Old Mail|Cleanup|Inbox Report/);
    expect(layout).toMatch(/<AppFooter \/>/);
  });

  it("keeps the public homepage and public routes in the marketing shell regardless of session state", () => {
    const home = readFileSync("app/page.tsx", "utf8");
    const publicDynamicPage = readFileSync("app/[slug]/page.tsx", "utf8");
    const publicDataAccess = readFileSync("app/data-access/page.tsx", "utf8");
    const appLayout = readFileSync("app/app/layout.tsx", "utf8");

    expect(home).toMatch(/<Header \/>/);
    expect(home).toMatch(/<Footer \/>/);
    expect(home).toMatch(/getPublicPrimaryCta/);
    expect(home).toMatch(/See what&apos;s clogging your inbox/);
    expect(home).not.toMatch(/redirect\(["']\/app/);
    expect(publicDynamicPage).toMatch(/<Header \/>/);
    expect(publicDynamicPage).toMatch(/<Footer \/>/);
    expect(publicDataAccess).toMatch(/<Header \/>/);
    expect(publicDataAccess).toMatch(/<Footer \/>/);
    expect(appLayout).toMatch(/<AppFooter \/>/);
    expect(existsSync("middleware.ts")).toBe(false);
    expect(existsSync("src/middleware.ts")).toBe(false);
  });

  it("uses full accessible brand links to the public homepage everywhere", () => {
    const marketingHeader = readFileSync("src/components/marketing/Header.tsx", "utf8");
    const appLayout = readFileSync("app/app/layout.tsx", "utf8");
    const appHeaderSection = appLayout.slice(appLayout.indexOf("<header"), appLayout.indexOf("</header>"));

    expect(marketingHeader).toMatch(/<Link href="\/" aria-label="Organizinbox home" className="focus-ring flex items-center gap-3 rounded-md/);
    expect(marketingHeader).toMatch(/<Image[\s\S]+<span>Organizinbox<\/span>[\s\S]+<\/Link>/);

    expect(appLayout).not.toMatch(/brandHref|connection\.mode === "connected" \? "\/app" : "\/"/);
    expect(appHeaderSection).toMatch(/<Link href="\/" aria-label="Organizinbox home" className="focus-ring flex items-center gap-3 rounded-md/);
    expect(appHeaderSection).toMatch(/<Image[\s\S]+<span>Organizinbox<\/span>[\s\S]+<\/Link>/);
    expect(appHeaderSection).not.toMatch(/clearLiveScan|clearSessionCookie|clearGmailCleanupJobsForUser|clearOAuthStateCookie|disconnectCurrentGmailSession/);
  });

  it("applies the same app brand home link to report, cleanup, account, help, security, and data-access app routes", () => {
    const layout = readFileSync("app/app/layout.tsx", "utf8");
    const appRoutes = ["app/page.tsx", "app/scan/page.tsx", "app/report/page.tsx", "app/cleanup/page.tsx", "app/account/page.tsx", "app/help/page.tsx", "app/security/page.tsx", "app/data-access/page.tsx", "app/privacy/page.tsx"];

    expect(layout).toMatch(/<Link href="\/" aria-label="Organizinbox home"/);
    for (const route of appRoutes) {
      expect(readFileSync(`app/${route}`, "utf8")).not.toMatch(/Header \/>|Footer \/>/);
    }
  });

  it("provides app-to-public Home navigation without touching provider or report state", () => {
    const footer = readFileSync("src/components/product/AppFooter.tsx", "utf8");

    expect(footer).toMatch(/<Link href="\/">Home<\/Link>/);
    expect(footer).toMatch(/href="\/app\/data-access"/);
    expect(footer).toMatch(/href="\/app\/security"/);
    expect(footer).toMatch(/href="\/app\/help"/);
    expect(footer).toMatch(/href="\/app\/privacy"/);
    expect(footer).not.toMatch(/clearLiveScan|clearSessionCookie|clearGmailCleanupJobsForUser|clearOAuthStateCookie|disconnectCurrentGmailSession|api\/oauth/);
  });

  it("keeps app-context support pages inside the app shell", () => {
    const security = readFileSync("app/app/security/page.tsx", "utf8");
    const dataAccess = readFileSync("app/app/data-access/page.tsx", "utf8");
    const privacy = readFileSync("app/app/privacy/page.tsx", "utf8");
    const help = readFileSync("app/app/help/page.tsx", "utf8");
    const account = readFileSync("app/app/account/page.tsx", "utf8");

    for (const source of [security, dataAccess, privacy, help]) {
      expect(source).toMatch(/BackToReportAction/);
      expect(source).toMatch(/getOptionalActiveReportState/);
      expect(source).not.toMatch(/Header \/>|Footer \/>/);
    }
    expect(account).toMatch(/BackToReportAction activeReport=\{activeReport\}/);
    expect(account).toMatch(/getOptionalActiveReportState/);
  });

  it("keeps public security and data-access pages in the marketing shell", () => {
    const publicDynamicPage = readFileSync("app/[slug]/page.tsx", "utf8");
    const publicDataAccess = readFileSync("app/data-access/page.tsx", "utf8");

    expect(publicDynamicPage).toMatch(/<Header \/>/);
    expect(publicDynamicPage).toMatch(/<Footer \/>/);
    expect(publicDataAccess).toMatch(/<Header \/>/);
    expect(publicDataAccess).toMatch(/<Footer \/>/);
  });

  it("moves old report routes into the active report context instead of loading fixtures", () => {
    for (const route of ["senders", "categories", "old-mail"]) {
      const source = readFileSync(`app/app/${route}/page.tsx`, "utf8");
      expect(source).toMatch(/redirect\("\/app\/report\?view=/);
      expect(source).not.toMatch(/getFixtureInboxReport/);
    }
  });

  it("resolves report and cleanup from the same active report state", () => {
    const reportPage = readFileSync("app/app/report/page.tsx", "utf8");
    const cleanupPage = readFileSync("app/app/cleanup/page.tsx", "utf8");

    expect(reportPage).toMatch(/getActiveReportStateOrRedirect/);
    expect(reportPage).toMatch(/"senders", "categories", "old-mail"/);
    expect(cleanupPage).toMatch(/getActiveReportStateOrRedirect/);
    expect(cleanupPage).toMatch(/publicCleanupGroupsFromReport\(activeReport\.report\.senders\)/);
    expect(cleanupPage).toMatch(/Back to Inbox Report/);
    expect(cleanupPage).not.toMatch(/getFixtureInboxReport/);
  });

  it("only permits fixture data through the source-aware report resolver", () => {
    const resolver = readFileSync("src/lib/server/report-state.ts", "utf8");

    expect(resolver).toMatch(/runtimeConfig\.fixtureMode/);
    expect(resolver).toMatch(/source: "fixture"/);
    expect(resolver).toMatch(/source: `\$\{liveScan\.progress\.provider\}-live`/);
    expect(resolver).toMatch(/redirect\("\/app"\)/);
  });

  it("documents the internal report navigation model in the spec", () => {
    const spec = readFileSync("organizinbox-specs.md", "utf8");

    expect(spec).toMatch(/stable, simple global header and footer/);
    expect(spec).toMatch(/Public marketing pages use the marketing shell/);
    expect(spec).toMatch(/active Organizinbox workflow uses the app shell/);
    expect(spec).toMatch(/`\/app` is the canonical state-aware application home/);
    expect(spec).toMatch(/The public homepage always renders the public Organizinbox marketing homepage/);
    expect(spec).toMatch(/Provider connection or session state must never make `\/` become `\/app`/);
    expect(spec).toMatch(/Route context decides the shell/);
    expect(spec).toMatch(/Brand navigation must use one clickable Organizinbox brand link/);
    expect(spec).toMatch(/The Organizinbox brand\/logo link always navigates to `\/` everywhere/);
    expect(spec).toMatch(/The footer Home link always navigates to `\/`/);
    expect(spec).toMatch(/Final public information architecture/);
    expect(spec).toMatch(/\/app\/privacy/);
    expect(spec).toMatch(/Outlook support is coming soon/);
    expect(spec).not.toMatch(/Inside the app shell, the Organizinbox brand link is state-aware/);
    expect(spec).not.toMatch(/when a valid provider connection exists, link to `\/app`/);
    expect(spec).toMatch(/`Disconnect Gmail` is the ordinary end of Organizinbox access/);
    expect(spec).toMatch(/must not call Google\'s revoke endpoint/);
    expect(spec).toMatch(/`Remove Google authorization` is a distinct lower-priority Account action/);
    expect(spec).toMatch(/Senders`, `Categories`, and `Old Mail` live inside the current Inbox Report/);
    expect(spec).toMatch(/fixture data must never be used as fallback data when fixture mode is disabled/);
  });

  it("replaces the old settings screen with account routing", () => {
    const settings = readFileSync("app/app/settings/page.tsx", "utf8");
    expect(settings).toMatch(/redirect\("\/app\/account"\)/);
    expect(settings).not.toMatch(/No real inbox connected|Disconnect fixture session/);
  });

  it("account resolves persistent connection state separately from report state", () => {
    const accountState = readFileSync("src/lib/server/account-state.ts", "utf8");
    const accountPage = readFileSync("app/app/account/page.tsx", "utf8");

    expect(accountState).toMatch(/getCurrentProviderConnection/);
    expect(accountState).toMatch(/mode: "connected"/);
    expect(accountPage).toMatch(/Gmail connected/);
    expect(accountPage).toMatch(/No current report/);
    expect(accountPage).toMatch(/No provider connected/);
    expect(accountPage).toMatch(/DEVELOPMENT FIXTURE/);
  });

  it("adds a state-aware app home, normal scan route, and connected homepage CTA", () => {
    const appHome = readFileSync("app/app/page.tsx", "utf8");
    const scanPage = readFileSync("app/app/scan/page.tsx", "utf8");
    const header = readFileSync("src/components/marketing/Header.tsx", "utf8");
    const home = readFileSync("app/page.tsx", "utf8");

    expect(appHome).toMatch(/getAppHomeState/);
    expect(appHome).toMatch(/connected_no_report/);
    expect(appHome).toMatch(/connected_active_report/);
    expect(appHome).toMatch(/Your Inbox Report has expired/);
    expect(scanPage).toMatch(/GmailScanClient/);
    expect(scanPage).not.toMatch(/benchmark/i);
    expect(header).toMatch(/getPublicPrimaryCta/);
    expect(home).toMatch(/getPublicPrimaryCta/);
  });

  it("keeps public homepage CTA session-aware without replacing the homepage or starting oauth for connected states", () => {
    const appState = readFileSync("src/lib/server/app-state.ts", "utf8");
    const home = readFileSync("app/page.tsx", "utf8");

    expect(appState).toMatch(/getCurrentProviderConnection/);
    expect(appState).toMatch(/connected_active_report[\s\S]+href: "\/app\/report", label: "Return to Inbox Report"/);
    expect(appState).toMatch(/connected_no_report[\s\S]+href: "\/app\/scan", label: "Scan my inbox"/);
    expect(appState).toMatch(/needs_reconnect[\s\S]+href: "\/connect\/google", label: "Reconnect Gmail"/);
    expect(appState).toMatch(/href: "\/connect\/google", label: "Clean my inbox"/);
    expect(home).not.toMatch(/redirect\(["']\/app/);
  });

  it("uses the final public header links and accessible mobile menu", () => {
    const header = readFileSync("src/components/marketing/Header.tsx", "utf8");
    const mobileMenu = readFileSync("src/components/marketing/MobileMarketingMenu.tsx", "utf8");

    expect(header).toMatch(/href: "\/gmail-cleaner", label: "Gmail"/);
    expect(header).toMatch(/href: "\/outlook-cleaner", label: "Outlook"/);
    expect(header).toMatch(/href: "\/guides", label: "Guides"/);
    expect(header).toMatch(/href: "\/pricing", label: "Pricing"/);
    expect(header).toMatch(/href: "\/security", label: "Security"/);
    expect(header).not.toMatch(/\/#product|Product|How It Works/);
    expect(header).toMatch(/MobileMarketingMenu/);
    expect(mobileMenu).toMatch(/aria-expanded/);
    expect(mobileMenu).toMatch(/aria-controls="mobile-marketing-navigation"/);
    expect(mobileMenu).toMatch(/onClick=\{\(\) => setOpen\(false\)\}/);
  });

  it("turns the public footer into a crawlable site map", () => {
    const footer = readFileSync("src/components/marketing/Footer.tsx", "utf8");

    for (const href of [
      "/gmail-cleaner",
      "/outlook-cleaner",
      "/pricing",
      "/#how-it-works",
      "/guides",
      "/delete-old-emails",
      "/delete-emails-by-sender",
      "/delete-newsletters",
      "/free-up-gmail-storage",
      "/inbox-reset",
      "/security",
      "/data-access",
      "/privacy",
      "/about"
    ]) {
      expect(footer).toContain(`href: "${href}"`);
    }
  });

  it("makes guides a real hub and adds explicit related links to SEO pages", () => {
    const marketingPages = readFileSync("src/lib/marketing-pages.ts", "utf8");
    const dynamicPage = readFileSync("app/[slug]/page.tsx", "utf8");
    const guidesHub = readFileSync("src/components/product/GuidesHubContent.tsx", "utf8");
    const template = readFileSync("src/components/product/MarketingInfoContent.tsx", "utf8");

    expect(marketingPages).toMatch(/providerIntent/);
    expect(marketingPages).toMatch(/contentCluster/);
    expect(marketingPages).toMatch(/relatedSlugs/);
    expect(dynamicPage).toMatch(/page\.slug === "guides"[\s\S]+GuidesHubContent/);
    expect(guidesHub).toMatch(/bulk-delete-emails/);
    expect(guidesHub).toMatch(/delete-emails-by-sender/);
    expect(guidesHub).toMatch(/delete-old-emails/);
    expect(guidesHub).toMatch(/delete-newsletters/);
    expect(guidesHub).toMatch(/free-up-gmail-storage/);
    expect(guidesHub).toMatch(/free-up-outlook-storage/);
    expect(guidesHub).toMatch(/inbox-reset/);
    expect(template).toMatch(/Related guides/);
    expect(template).toMatch(/getMarketingPagesBySlugs\(page\.relatedSlugs\)/);
  });

  it("keeps Outlook honest while unavailable and gates Microsoft OAuth behind a dev flag", () => {
    const availability = readFileSync("src/lib/providers/availability.ts", "utf8");
    const marketingTemplate = readFileSync("src/components/product/MarketingInfoContent.tsx", "utf8");
    const microsoftConnect = readFileSync("app/connect/microsoft/page.tsx", "utf8");
    const microsoftStart = readFileSync("app/api/oauth/microsoft/start/route.ts", "utf8");
    const appHome = readFileSync("app/app/page.tsx", "utf8");
    const account = readFileSync("app/app/account/page.tsx", "utf8");

    expect(availability).toMatch(/microsoft:[\s\S]+status: "comingSoon"/);
    expect(marketingTemplate).toMatch(/Outlook support is coming soon/);
    expect(marketingTemplate).toMatch(/Clean Gmail instead/);
    expect(microsoftConnect).toMatch(/Outlook support is coming soon/);
    expect(microsoftConnect).toMatch(/MICROSOFT_OAUTH_DEV_ENABLED=true/);
    expect(microsoftStart).toMatch(/microsoftOAuthDevEnabled/);
    expect(microsoftStart).toMatch(/status: 404/);
    expect(appHome).not.toMatch(/href="\/connect\/microsoft"/);
    expect(account).not.toMatch(/href="\/connect\/microsoft"/);
  });

  it("keeps connect pages in the marketing shell with noindex recovery", () => {
    const googleConnect = readFileSync("app/connect/google/page.tsx", "utf8");
    const googleError = readFileSync("app/connect/google/error/page.tsx", "utf8");
    const microsoftConnect = readFileSync("app/connect/microsoft/page.tsx", "utf8");

    for (const source of [googleConnect, googleError, microsoftConnect]) {
      expect(source).toMatch(/<Header \/>/);
      expect(source).toMatch(/<Footer \/>/);
      expect(source).toMatch(/robots:[\s\S]+index: false/);
    }
    expect(googleConnect).toMatch(/You do not need to reconnect Gmail/);
    expect(googleConnect).toMatch(/connectedHref/);
    expect(googleError).toMatch(/Try connecting Gmail again/);
    expect(googleError).toMatch(/href="\/"[\s\S]+Back to homepage/);
  });

  it("keeps app privacy in the app shell and reuses shared privacy content", () => {
    const publicDynamicPage = readFileSync("app/[slug]/page.tsx", "utf8");
    const appPrivacy = readFileSync("app/app/privacy/page.tsx", "utf8");
    const privacyContent = readFileSync("src/components/product/PrivacyContent.tsx", "utf8");

    expect(publicDynamicPage).toMatch(/page\.slug === "privacy"[\s\S]+PrivacyContent/);
    expect(appPrivacy).toMatch(/<PrivacyContent appContext \/>/);
    expect(appPrivacy).not.toMatch(/Header \/>|Footer \/>/);
    expect(privacyContent).toMatch(/Privacy is part of the product/);
    expect(privacyContent).not.toMatch(/prisma|providerConnection|senderKey|messageId/i);
  });

  it("makes report and cleanup workflow recovery actions explicit", () => {
    const reportView = readFileSync("src/components/product/InboxReportView.tsx", "utf8");
    const cleanupClient = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");
    const cleanupPage = readFileSync("app/app/cleanup/page.tsx", "utf8");
    const benchmarkPage = readFileSync("app/app/dev/gmail-benchmark/page.tsx", "utf8");

    expect(reportView).toMatch(/Back to Organizinbox/);
    expect(cleanupPage).toMatch(/Back to Inbox Report/);
    expect(cleanupClient).toMatch(/fetch\("\/api\/app\/gmail-scan\/start", \{ method: "POST" \}\)[\s\S]+router\.push\("\/app\/scan"\)/);
    expect(cleanupClient).toMatch(/onClick=\{onRescan\}[\s\S]+Rescan inbox/);
    expect(cleanupClient).toMatch(/href="\/app\/report"[\s\S]+Back to Inbox Report/);
    expect(benchmarkPage).toMatch(/Back to Organizinbox/);
  });

  it("keeps normal scan separate from development benchmark tooling", () => {
    const scanStart = readFileSync("app/api/app/gmail-scan/start/route.ts", "utf8");
    const benchmarkStart = readFileSync("app/api/dev/gmail-benchmark/start/route.ts", "utf8");

    expect(scanStart).toMatch(/createGmailScanSession/);
    expect(scanStart).not.toMatch(/assertDevBenchmarkEnabled|limit|batchSize/);
    expect(benchmarkStart).toMatch(/assertDevBenchmarkEnabled/);
  });

  it("normal Disconnect uses a confirmation POST flow and destroys local credentials plus transient state", () => {
    const disconnect = readFileSync("src/lib/server/disconnect.ts", "utf8");
    const account = readFileSync("app/app/account/page.tsx", "utf8");
    const confirmation = readFileSync("src/components/product/DisconnectGmailConfirmation.tsx", "utf8");
    const route = readFileSync("app/api/app/disconnect/route.ts", "utf8");

    expect(disconnect).toMatch(/disconnectCurrentGmailSessionWithMode\("local_disconnect"\)/);
    expect(disconnect).toMatch(/clearLiveScan/);
    expect(disconnect).toMatch(/clearGmailCleanupJobsForUser/);
    expect(disconnect).toMatch(/clearSessionCookie/);
    expect(disconnect).toMatch(/encryptedAccessToken: null/);
    expect(disconnect).toMatch(/encryptedRefreshToken: null/);
    expect(account).toMatch(/DisconnectGmailConfirmation/);
    expect(account).not.toMatch(/<form action="\/api\/app\/disconnect"/);
    expect(confirmation).toMatch(/Disconnect Gmail\?/);
    expect(confirmation).toMatch(/saved Gmail access/);
    expect(confirmation).not.toMatch(/connected apps|remove Google authorization/i);
    expect(confirmation).toMatch(/Cancel/);
    expect(confirmation).toMatch(/action="\/api\/app\/disconnect" method="post"/);
    expect(confirmation).not.toMatch(/<Link[^>]+href="\/api\/app\/disconnect"/);
    expect(route).toMatch(/export async function GET/);
    expect(route).toMatch(/status: 405/);
    expect(route).toMatch(/export async function POST\(request: Request\)/);
    expect(route).toMatch(/isSameOriginPost/);
    expect(route).toMatch(/NextResponse\.redirect\(new URL\("\/", request\.url\), \{ status: 303 \}\)/);
    expect(route).not.toMatch(/Response\.json\(await disconnectCurrentGmailSession/);
  });

  it("keeps Google authorization removal separate, confirmed, POST-only, and lower priority", () => {
    const disconnect = readFileSync("src/lib/server/disconnect.ts", "utf8");
    const config = readFileSync("src/lib/config.ts", "utf8");
    const envExample = readFileSync(".env.example", "utf8");
    const account = readFileSync("app/app/account/page.tsx", "utf8");
    const confirmation = readFileSync("src/components/product/RemoveGoogleAuthorizationConfirmation.tsx", "utf8");
    const route = readFileSync("app/api/app/remove-google-authorization/route.ts", "utf8");

    expect(disconnect).toMatch(/removeCurrentGoogleAuthorization[\s\S]+"remote_revoke"/);
    expect(account).toMatch(/Google Account authorization/);
    expect(account).toMatch(/RemoveGoogleAuthorizationConfirmation/);
    expect(confirmation).toMatch(/Remove Google authorization\?/);
    expect(confirmation).toMatch(/Google may take a short time/);
    expect(confirmation).toMatch(/action="\/api\/app\/remove-google-authorization" method="post"/);
    expect(confirmation).not.toMatch(/<Link[^>]+remove-google-authorization/);
    expect(route).toMatch(/export async function GET/);
    expect(route).toMatch(/status: 405/);
    expect(route).toMatch(/isSameOriginPost/);
    expect(route).toMatch(/removeCurrentGoogleAuthorization/);
    expect(route).not.toMatch(/token=|accessToken|refreshToken/);
    expect(config).not.toMatch(/GMAIL_LOCAL_DISCONNECT_TEST_ENABLED|isGmailLocalDisconnectTestEnabled/);
    expect(envExample).not.toMatch(/GMAIL_LOCAL_DISCONNECT_TEST_ENABLED/);
    expect(account).not.toMatch(/DEVELOPMENT ONLY|Dev: Disconnect locally|showLocalDisconnectTest/);
  });
});
