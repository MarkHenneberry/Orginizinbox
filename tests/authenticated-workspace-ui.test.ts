import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/product/AppHeader";
import { AppFooter } from "@/components/product/AppFooter";
import { CleanupCreditContext } from "@/components/product/CleanupCreditContext";
import { BillingActions } from "@/components/product/BillingActions";
import { getCreditPresentation, getLinkedInboxCount } from "@/lib/server/credit-presentation";
import { getAccountConnectionState } from "@/lib/server/account-state";
import AccountPage from "../app/app/account/page";
import HelpPage from "../app/app/help/page";
import CreditsPage from "../app/app/credits/page";

const navigation = vi.hoisted(() => ({ path: "/app/report" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.path, useRouter: () => ({ refresh: vi.fn() }), redirect: (url: string) => { throw new Error(url); } }));
vi.mock("next/image", () => ({ default: ({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) => createElement("img", { src, alt, width, height }) }));
vi.mock("@/lib/server/report-state", () => ({ getOptionalActiveReportState: async () => ({ source: "microsoft-live", scanId: "fixture", backHref: "/app" }) }));
vi.mock("@/lib/server/account-state", () => ({ getAccountConnectionState: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({ getBillingConfig: () => ({}) }));
vi.mock("@/lib/server/credit-presentation", () => ({ getCreditPresentation: vi.fn(), getLinkedInboxCount: vi.fn() }));
vi.mock("@/components/product/BillingPanel", () => ({ BillingPanel: () => createElement("section", { className: "credits-content" },
  createElement("p", {}, "Pay once. No subscription. Credits don't expire."),
  createElement("dl", { className: "credit-balances" }, ...[["Available", "60,000"], ["Reserved for active cleanup", "500"], ["Total balance", "60,500"]].map(([label, amount]) => createElement("div", { key: label }, createElement("dt", {}, label), createElement("dd", {}, amount)))),
  createElement(BillingActions, { canBuy: true, canRefresh: true })) }));

const headerProps = { logoPath: "oi-logo.png", provider: "microsoft" as const, availableCredits: 60000, reportAvailable: true, scanAvailable: true, cleanupAvailable: true };
it("loads dedicated workspace styles from the authenticated layout", () => {
  expect(readFileSync("app/app/layout.tsx", "utf8")).toContain('import "./workspace-v2.css"');
  const css = readFileSync("app/app/workspace-v2.css", "utf8");
  const globalCss = readFileSync("app/globals.css", "utf8");
  for (const selector of [".product-header", ".app-header-inner", ".account-menu-items", ".settings-columns", ".help-group"]) {
    expect(css).toContain(`${selector} {`);
    expect(globalCss).not.toContain(`${selector} {`);
  }
  expect(css).toMatch(/\.app-header-inner \{[^}]*display: flex;[^}]*flex-wrap: nowrap;/);
});
function render(name: string, content: React.ReactNode) {
  const html = renderToStaticMarkup(createElement("div", { className: "product-shell" }, createElement(AppHeader, headerProps), createElement("div", { className: "product-content" }, content), createElement(AppFooter)));
  if (process.env.UI_PREVIEW_DIR) {
    mkdirSync(process.env.UI_PREVIEW_DIR, { recursive: true });
    writeFileSync(join(process.env.UI_PREVIEW_DIR, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="compiled.css"><title>UI fixture</title></head><body>${html}</body></html>`);
  }
  return html;
}
beforeEach(() => {
  navigation.path = "/app/report";
  vi.mocked(getCreditPresentation).mockResolvedValue({ available: 60000, reserved: 500, balance: 60500 });
  vi.mocked(getLinkedInboxCount).mockResolvedValue(2);
  vi.mocked(getAccountConnectionState).mockResolvedValue({ mode: "connected", provider: "microsoft", status: "Connected", hasActiveReport: true, accountEmail: "a.long.fixture.address@example.test" });
});
it("shows the supplied available balance and contextual desktop/mobile navigation", () => {
  const html = renderToStaticMarkup(createElement(AppHeader, headerProps));
  expect(html).toContain("60,000 credits");
  expect(html).toContain('href="/app/credits"');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('class="mobile-workflow-nav"');
  expect(html).toContain("<details");
  expect(html).toContain('<svg class="account-menu-chevron" width="14" height="14"');
  expect(html).toContain('stroke="currentColor"');
  expect(html).toContain('stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"');
  expect(html).not.toMatch(/api\/|Disconnect/);
  navigation.path = "/app/scan";
  const unavailable = renderToStaticMarkup(createElement(AppHeader, { ...headerProps, availableCredits: null, reportAvailable: false, cleanupAvailable: false }));
  expect(unavailable).not.toMatch(/href="\/app\/report"|href="\/app\/cleanup"|0 credits/);
  expect(unavailable).toContain('href="/app/scan"');
  const recovery = renderToStaticMarkup(createElement(AppHeader, { ...headerProps, reportAvailable: false }));
  expect(recovery).toContain('href="/app/cleanup"');
  navigation.path = "/app/report";
  const newlyCompleted = renderToStaticMarkup(createElement(AppHeader, { ...headerProps, reportAvailable: false, cleanupAvailable: false, cleanupStartAvailable: true }));
  expect(newlyCompleted).toContain('href="/app/report"');
  expect(newlyCompleted).toContain('href="/app/cleanup"');
});
it("makes Account a connection/linked-inbox settings page without purchase packs", async () => {
  const html = render("account", await AccountPage());
  expect(html).toContain("Manage credits");
  expect(html).toContain("60,000");
  expect(html).toContain("2 inboxes share");
  expect(html).toContain("Link another inbox");
  expect(html).not.toContain("credit-pack");
  expect(html).toContain("Disconnect");
});
it("keeps old Checkout return URLs pointing at the existing reconciliation presentation", async () => {
  await expect(AccountPage({ searchParams: Promise.resolve({ billing: "returned" }) })).rejects.toThrow("/app/credits?billing=returned");
});
it("provides a dedicated credits page with one-time packs and payment-status action", async () => {
  const html = render("credits", await CreditsPage());
  for (const text of ["10,000", "50,000", "100,000", "Recommended", "Check payment status", "Reserved for active cleanup", "Total balance"]) expect(html).toContain(text);
});
it("uses provider-neutral Help disclosures with truthful Undo and privacy content", async () => {
  const html = render("help", await HelpPage());
  expect(html.match(/<details/g)?.length).toBeGreaterThanOrEqual(8);
  expect(html).toContain("Disconnecting your inbox");
  expect(html).not.toContain("Disconnecting Gmail");
  for (const text of ["Suggested", "Review", "Protected", "temporary restoration state", "permanent deletion requires separate confirmation", "Subject lines", "encrypted"]) expect(html).toContain(text);
});
it("shows insufficient-credit context without blocking reserved-job recovery", () => {
  const html = render("credit-context", createElement("main", { className: "container settings-page" }, createElement(CleanupCreditContext, { available: 5000, requested: 8231 })));
  expect(html).toContain("You need 8,231 credits");
  expect(html).toContain("Buy credits");
  expect(html).toContain('href="/app/credits"');
  const reserved = renderToStaticMarkup(createElement(CleanupCreditContext, { available: 0, requested: 500, reserved: true }));
  expect(reserved).not.toContain("Buy credits");
  expect(reserved).toContain("existing reservation");
});
