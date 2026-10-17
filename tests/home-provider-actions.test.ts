import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getHomeProviderActions, homepageAvailability } from "@/lib/server/home-provider-actions";
import { HomeProviderActions } from "@/components/marketing/HomeProviderActions";
const h = vi.hoisted(() => ({ state: vi.fn(), list: vi.fn(), infrastructure: vi.fn(), billing: vi.fn(),
  config: { gmailAvailable: true, microsoftAvailable: true, gmailCleanupEnabled: false, gmailScalableCleanupDevEnabled: false,
    outlookCleanupDevEnabled: false, microsoftOAuthDevEnabled: false } }));
vi.mock("@/lib/server/app-state", () => ({ getAppHomeState: h.state }));
vi.mock("@/lib/server/linked-inboxes", () => ({ getLinkedInboxes: h.list }));
vi.mock("@/lib/config", () => ({ runtimeConfig: h.config }));
vi.mock("@/lib/server/production-cleanup", () => ({ assertProductionCleanupInfrastructure: h.infrastructure }));
vi.mock("@/lib/billing/config", () => ({ getBillingConfig: h.billing }));
beforeEach(() => {
  vi.clearAllMocks(); h.state.mockResolvedValue({ mode: "none" }); h.list.mockResolvedValue([]);
  h.config.gmailAvailable = true; h.config.microsoftAvailable = true;
  h.billing.mockReturnValue({}); h.infrastructure.mockImplementation(() => { throw new Error("off"); });
});
afterEach(() => vi.unstubAllEnvs());
it("shows both provider-specific connection actions without a session", async () => {
  const html = renderToStaticMarkup(createElement(HomeProviderActions, { actions: await getHomeProviderActions() }));
  for (const copy of ["Scan Gmail inbox", "Scan Outlook inbox", 'href="/connect/google"', 'href="/connect/microsoft"']) expect(html).toContain(copy);
});
it.each(["gmail", "microsoft"])("keeps both actions when %s is active and opens its current report", async provider => {
  h.state.mockResolvedValue({ mode: "connected_active_report", provider });
  const actions = await getHomeProviderActions();
  expect(actions).toHaveLength(2);
  expect(actions.find(action => action.provider === provider)).toMatchObject({ href: "/app/report", label: provider === "gmail" ? "View Gmail report" : "View Outlook report" });
  expect(actions.find(action => action.provider !== provider)?.href).toMatch(/^\/connect\//);
});
it("uses the authenticated switch action for linked inactive providers instead of OAuth", async () => {
  h.state.mockResolvedValue({ mode: "connected_no_report", provider: "microsoft" });
  h.list.mockResolvedValue([{ id: "opaque-gmail", provider: "gmail", state: "ready" }]);
  const actions = await getHomeProviderActions();
  expect(actions[0]).toMatchObject({ connectionId: "opaque-gmail", label: "Open Gmail inbox" });
  const html = renderToStaticMarkup(createElement(HomeProviderActions, { actions }));
  expect(html).toContain("Open Gmail inbox</button>"); expect(html).toContain("Scan Outlook inbox");
  expect(html).not.toContain('href="/connect/google"');
});
it("shows disabled providers explicitly and derives production cleanup copy independently from infrastructure", () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(homepageAvailability().anyCleanup).toBe(false);
  h.infrastructure.mockImplementation((provider: string) => { if (provider === "microsoft") throw new Error("off"); });
  expect(homepageAvailability()).toMatchObject({ gmailCleanup: true, outlookCleanup: false, cleanupCopy: "Cleanup is available for Gmail with cleanup credits." });
  h.config.gmailAvailable = false;
  expect(homepageAvailability().anyCleanup).toBe(false);
  h.config.gmailAvailable = true; h.billing.mockReturnValue(null);
  expect(homepageAvailability().anyCleanup).toBe(false);
});
