import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import GoogleErrorPage from "../app/connect/google/error/page";
import MicrosoftConnectPage from "../app/connect/microsoft/page";

vi.mock("@/components/marketing/Header", () => ({ Header: () => null }));
vi.mock("@/components/marketing/Footer", () => ({ Footer: () => null }));
vi.mock("@/components/product/ContextBackAction", () => ({ ContextBackAction: ({ href, label }: { href: string; label: string }) => createElement("a", { href }, label) }));
vi.mock("@/lib/config", () => ({ runtimeConfig: { gmailAvailable: true, microsoftAvailable: true } }));
vi.mock("@/lib/server/provider-connection-state", () => ({ getCurrentProviderConnection: vi.fn(() => { throw new Error("Link failure must not enter ordinary connection UI"); }) }));

it.each(["failed", "activation_failed"])("keeps %s recovery on Account for both providers without standalone OAuth", async (link) => {
  for (const page of [GoogleErrorPage, MicrosoftConnectPage]) {
    const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve({ reason: "oauth_denied", link }) }));
    expect(html).toContain('href="/app/account"');
    expect(html).toContain("Return to Account");
    expect(html).not.toMatch(/api\/oauth|<form|Try connecting/);
    expect(html).toContain(link === "failed" ? "Your existing inbox and credits were unchanged" : "was linked, but could not be opened");
  }
});
it("retains normal Gmail retry for a non-link error", async () => {
  const html = renderToStaticMarkup(await GoogleErrorPage({ searchParams: Promise.resolve({ reason: "oauth_denied" }) }));
  expect(html).toContain('action="/api/oauth/google/start"');
  expect(html).toContain("Try connecting Gmail again");
});
