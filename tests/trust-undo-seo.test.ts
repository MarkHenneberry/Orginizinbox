import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UndoAction } from "@/components/product/UndoAction";
import { DisconnectUndoWarning } from "@/components/product/DisconnectUndoWarning";
import { undoPresentation, subscribeToUndoDeadline } from "@/lib/undo-presentation";
import { cleanupGuides } from "@/lib/cleanup-guides";
import { marketingPages, getMarketingPage } from "@/lib/marketing-pages";
import { MarketingInfoContent } from "@/components/product/MarketingInfoContent";
import { generateMetadata } from "../app/[slug]/page";
import robots from "../app/robots";
import sitemap from "../app/sitemap";

const config = vi.hoisted(() => ({ development: false, gmailAvailable: false, microsoftOAuthDevEnabled: false,
  cleanupStateActiveTtlSeconds: 600, cleanupStateUndoTtlSeconds: 900, cleanupStateTerminalTtlSeconds: 60 }));
vi.mock("@/lib/config", () => ({ runtimeConfig: config, siteConfig: { url: "https://example.test", name: "Organizinbox", logoPath: "/logo.png" } }));
vi.mock("@/lib/providers/availability", () => ({ providerAvailability: { microsoft: { status: "comingSoon" } } }));
vi.mock("@/components/marketing/Header", () => ({ Header: () => null }));
vi.mock("@/components/marketing/Footer", () => ({ Footer: () => null }));
vi.mock("@/lib/server/app-state", () => ({ getPublicPrimaryCta: async () => ({ href: "/connect", label: "View provider availability" }) }));

const now = Date.parse("2026-09-09T12:00:00Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); config.gmailAvailable = false; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("actual Undo deadlines without changing retention", () => {
  it("renders the state's absolute deadline and separates normal and Recovery Undo", () => {
    const onUndo = vi.fn();
    for (const recovery of [false, true]) {
      const html = renderToStaticMarkup(createElement(UndoAction, { available: true, expiresAt: now + 90_000, recovery, onUndo }));
      expect(html).toContain('dateTime="2026-09-09T12:01:30.000Z"');
      expect(html).toContain("UTC");
      expect(html).toContain(`${recovery ? "Recovery Undo" : "Undo"} until`);
      expect(html).toContain("temporary restoration state");
      expect(html).toContain("Disconnecting removes it");
      expect(html.includes("Uncertain messages are not included")).toBe(recovery);
    }
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("never offers expired, unavailable or already completed Undo", () => {
    for (const [props, label] of [
      [{ available: true, expiresAt: now }, "Undo expired"],
      [{ available: false, expiresAt: now + 60_000 }, "Undo unavailable"],
      [{ available: true, expiresAt: Number.NaN }, "Undo unavailable"],
      [{ available: true, expiresAt: now - 1, completed: true }, "Undo complete"]
    ] as const) {
      const html = renderToStaticMarkup(createElement(UndoAction, { ...props, onUndo: vi.fn() }));
      expect(html).toContain(label);
      expect(html).not.toContain("<button");
    }
  });

  it("updates expiry with terminal polling stopped and cleans up replaced deadline timers", async () => {
    const input = { available: true, expiresAt: now + 10_000 };
    let state = undoPresentation(input, Date.now()).state;
    const update = vi.fn(() => { state = undoPresentation(input, Date.now()).state; });
    const stop = subscribeToUndoDeadline(input.expiresAt, update);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(state).toBe("expired");
    expect(update).toHaveBeenCalledOnce();
    stop();
    const old = vi.fn();
    const dispose = subscribeToUndoDeadline(Date.now() + 1000, old);
    dispose();
    await vi.advanceTimersByTimeAsync(1001);
    expect(old).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks the deadline when a sleeping tab regains focus", () => {
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    const update = vi.fn();
    const stop = subscribeToUndoDeadline(now + 1000, update);
    vi.setSystemTime(now + 2000);
    window.dispatchEvent(new Event("focus"));
    expect(update).toHaveBeenCalledOnce();
    stop();
    window.dispatchEvent(new Event("focus"));
    expect(update).toHaveBeenCalledOnce();
  });

  it("warns before both disconnects and authorization removal without changing their actions", () => {
    const warning = renderToStaticMarkup(createElement(DisconnectUndoWarning));
    expect(warning).toContain("Recovery Undo");
    expect(warning).toContain("reconnecting will not bring Undo back");
    expect(warning).toContain("does not restore messages already moved");
    for (const file of ["DisconnectGmailConfirmation", "DisconnectMicrosoftConfirmation", "RemoveGoogleAuthorizationConfirmation"]) {
      const source = readFileSync(`src/components/product/${file}.tsx`, "utf8");
      expect(source).toContain("<DisconnectUndoWarning />");
      expect(source).toContain('method="post"');
      expect(source.indexOf("<DisconnectUndoWarning />")).toBeLessThan(source.indexOf("<form action="));
    }
    const cleanup = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");
    expect(cleanup.match(/<UndoAction[^>]+expiresAt=\{job\.expiresAt\}/g)!.length).toBeGreaterThanOrEqual(5);
  });
});

describe("four useful existing SEO pages", () => {
  it.each(Object.keys(cleanupGuides))("renders %s with steps, limitations, internal links and matching FAQ schema", async (slug) => {
    const page = getMarketingPage(slug)!;
    const html = renderToStaticMarkup(createElement(MarketingInfoContent, { page,
      primaryCta: { href: "/connect", label: "View provider availability" } }));
    expect(html).toContain("<ol");
    const steps = cleanupGuides[slug].steps;
    expect(steps).toHaveLength(5);
    for (const [index, label] of ["Scan your inbox.", "Review your Inbox Report.", "Choose what to clean.", "Confirm cleanup.", "Review the result."].entries()) {
      expect(steps[index].startsWith(label)).toBe(true);
      expect(html).toContain(label);
    }
    expect(steps[0]).toContain("scan the whole inbox");
    expect(steps[0]).toContain("Scanning does not move or delete anything");
    expect(steps[1]).toContain("Suggested, Review and Protected");
    expect(steps[3]).toContain("final safety checks and moves only approved messages");
    expect(steps[3]).toContain(slug === "outlook-cleaner" ? "Move to Deleted Items" : "Move to Trash");
    expect(steps[4]).toContain("displayed deadline");
    expect(html).not.toMatch(/Start with the clutter|Choose one area|Start with a date search|steps work directly in Gmail|sender-first|from:newsletter@example/);
    expect(html).toContain("Production cleanup is not available yet");
    expect(html).toContain("temporarily in encrypted form");
    expect(html).toContain("configured window is 15 minutes");
    expect(html).toContain('href="/data-access"');
    expect(html).toContain("Related guides");
    expect(html).not.toContain("Small development cleanups");
    const schema = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
    expect(schema["@type"]).toBe("FAQPage");
    expect(schema.mainEntity).toEqual(cleanupGuides[slug].faqs.map(({ question, answer }) => ({
      "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer }
    })));
    for (const { question, answer } of cleanupGuides[slug].faqs) {
      const escape = (value: string) => renderToStaticMarkup(createElement("span", null, value)).slice(6, -7);
      expect(html).toContain(escape(question));
      expect(html).toContain(escape(answer));
    }
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    expect(metadata).toMatchObject({ title: page.title, description: page.description, alternates: { canonical: `/${slug}` } });
  });

  it("preserves privacy substance in production instead of replacing it with provider availability", () => {
    const html = renderToStaticMarkup(createElement(MarketingInfoContent, { page: getMarketingPage("security")! }));
    expect(html).toContain("Saved connection credentials and temporary reports are encrypted");
    expect(html).toContain("even if you reconnect");
    expect(html).not.toContain("Read-only Inbox Reports are available for this provider");
  });

  it("retains disabled-provider wording and never claims enabled scanning enables cleanup", () => {
    const page = getMarketingPage("gmail-cleaner")!;
    const render = () => renderToStaticMarkup(createElement(MarketingInfoContent, { page }));
    expect(render()).toContain("Connection and scanning are currently unavailable");
    config.gmailAvailable = true;
    expect(render()).toContain("Read-only Inbox Reports are available for enabled accounts");
    expect(render()).toContain("Production cleanup is not available yet");
  });

  it("uses one crawler policy for all private routes, including bare app/connect paths", () => {
    expect(robots().rules).toEqual([{ userAgent: "*", allow: "/", disallow: ["/app", "/api", "/connect"] }]);
  });

  it("has stable public sitemap entries without invented modification dates or duplicate URLs", () => {
    const first = sitemap();
    vi.setSystemTime(now + 86400_000);
    expect(sitemap()).toEqual(first);
    expect(new Set(first.map((entry) => entry.url)).size).toBe(first.length);
    expect(first.every((entry) => entry.lastModified === undefined)).toBe(true);
    expect(first.some((entry) => /\/(app|api|connect)(\/|$)/.test(entry.url))).toBe(false);
    for (const slug of Object.keys(cleanupGuides)) expect(first.some((entry) => entry.url.endsWith(`/${slug}`))).toBe(true);
    for (const page of marketingPages) for (const slug of page.relatedSlugs) expect(getMarketingPage(slug)).toBeDefined();
  });
});
