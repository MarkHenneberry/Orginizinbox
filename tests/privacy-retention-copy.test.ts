import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetentionDisclosure } from "@/components/product/RetentionDisclosure";
import { DataAccessContent } from "@/components/product/DataAccessContent";
import { PrivacyContent } from "@/components/product/PrivacyContent";
import { retentionDuration, scanStateTtlMs, legacyCleanupTtlMs } from "@/lib/domain/transient-retention";

const config = vi.hoisted(() => ({
  cleanupStateActiveTtlSeconds: 1800,
  cleanupStateUndoTtlSeconds: 1800,
  cleanupStateTerminalTtlSeconds: 60
}));
vi.mock("@/lib/config", () => ({ runtimeConfig: config }));
afterEach(() => Object.assign(config, {
  cleanupStateActiveTtlSeconds: 1800, cleanupStateUndoTtlSeconds: 1800, cleanupStateTerminalTtlSeconds: 60
}));

describe("customer-facing encrypted retention disclosure", () => {
  it.each([DataAccessContent, PrivacyContent])("discloses temporary encrypted storage and existing windows in public and app shells", (component) => {
    for (const appContext of [false, true]) {
      const html = renderToStaticMarkup(createElement(component, { appContext }));
      expect(html).toContain("temporarily in encrypted form in our database");
      expect(html).toContain("1 hour without a saved update");
      expect(html).toContain("30 minutes active window");
      expect(html).toContain("30 minutes Undo window");
      expect(html).toContain("1 minute final-state window");
      expect(html).toContain("keeps temporary state for 10 minutes");
      expect(html).toContain("scheduled deletion runs every minute");
      expect(html).toContain("Service outages may delay deletion");
      expect(html).toContain("Database backup retention is separate");
      expect(html).not.toMatch(/not saved to your account database|never stored|immediately erased/i);
    }
  });

  it("uses configured cleanup windows instead of hardcoded default promises", () => {
    Object.assign(config, { cleanupStateActiveTtlSeconds: 600, cleanupStateUndoTtlSeconds: 900, cleanupStateTerminalTtlSeconds: 30 });
    const html = renderToStaticMarkup(createElement(RetentionDisclosure));
    expect(html).toContain("10 minutes active window");
    expect(html).toContain("15 minutes Undo window");
    expect(html).toContain("30 seconds final-state window");
    expect(html).not.toContain("30 minutes");
  });

  it("keeps existing TTLs and handles second/minute/hour copy without rounding down", () => {
    expect(scanStateTtlMs).toBe(3_600_000);
    expect(legacyCleanupTtlMs).toBe(600_000);
    expect([1, 60, 61, 120, 3600, 7200].map(retentionDuration)).toEqual([
      "1 second", "1 minute", "61 seconds", "2 minutes", "1 hour", "2 hours"
    ]);
  });

  it("corrects the homepage claim and keeps configuration server-only", () => {
    expect(readFileSync("app/page.tsx", "utf8")).toContain("stored temporarily in encrypted form and deleted after expiry");
    const source = readFileSync("src/components/product/RetentionDisclosure.tsx", "utf8");
    expect(source).toContain('import "server-only"');
    expect(source).not.toMatch(/CRON_SECRET|TOKEN_ENCRYPTION_KEY|DATABASE_URL/);
  });
});
