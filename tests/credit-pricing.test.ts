import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MarketingInfoContent } from "@/components/product/MarketingInfoContent";
import { getMarketingPage } from "@/lib/marketing-pages";
vi.mock("@/lib/billing/config", () => ({ getBillingConfig: () => null }));
vi.mock("@/lib/config", async (original) => {
  const actual = await original<typeof import("@/lib/config")>();
  return { ...actual, runtimeConfig: { ...actual.runtimeConfig, development: false, gmailAvailable: false, microsoftAvailable: false } };
});
describe("production credit pricing", () => {
  it("keeps the actual offer visible even when sales and providers are disabled", () => {
    const html = renderToStaticMarkup(createElement(MarketingInfoContent, { page: getMarketingPage("pricing")!, primaryCta: { href: "/connect", label: "View provider availability" } }));
    for (const text of ["10,000 credits", "50,000 credits", "100,000 credits", "$10", "$15", "$20", "No subscription", "Start with a free Inbox Scan", "Pay only for verified moves", "Credit purchases are not available yet"]) expect(html).toContain(text);
    expect(html).not.toMatch(/Read-only Inbox Reports are available for this provider|Subscription and billing|recurring subscription|Full Inbox Reset/);
    expect(html).toContain("Verified Undo returns that credit");
    expect(html).toContain("linked Gmail and Outlook inboxes");
  });
});
