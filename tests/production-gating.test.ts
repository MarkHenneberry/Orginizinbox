import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProductionProviders } from "@/lib/server/production-config";

// Boundary tests must not initialize the provider/Workflow execution tree.
const work = vi.hoisted(() => ({ session: vi.fn(), scan: vi.fn(), undo: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getSession: work.session, createOAuthState: work.session,
  consumeOAuthState: work.session, setSessionCookie: work.session }));
vi.mock("@/lib/server/gmail-benchmark", () => ({ createGmailScanSession: work.scan }));
vi.mock("@/lib/server/microsoft-scan", () => ({ createMicrosoftScanSession: work.scan }));
vi.mock("@/lib/server/outlook-cleanup", () => ({ undoOutlookCleanup: work.undo, OutlookCleanupError: class extends Error {} }));

const configured = {
  NEXT_PUBLIC_APP_URL: "https://example.test",
  DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
  TOKEN_ENCRYPTION_KEY: "t".repeat(32), CLEANUP_STATE_ENCRYPTION_KEY: "s".repeat(32), CRON_SECRET: "fixture-cron-secret",
  GOOGLE_CLIENT_ID: "fixture-google", GOOGLE_CLIENT_SECRET: "fixture-secret",
  GOOGLE_REDIRECT_URI: "https://example.test/api/oauth/google/callback",
  MICROSOFT_CLIENT_ID: "fixture-microsoft", MICROSOFT_CLIENT_SECRET: "fixture-secret", MICROSOFT_TENANT_ID: "common",
  MICROSOFT_REDIRECT_URI: "https://example.test/api/oauth/microsoft/callback",
  GMAIL_PRODUCTION_ENABLED: "true", MICROSOFT_PRODUCTION_ENABLED: "true"
};
const devFlags = [
  "GMAIL_BENCHMARK_ENABLED", "GMAIL_CLEANUP_ENABLED", "GMAIL_BULK_UNDO_PROOF_ENABLED",
  "GMAIL_BULK_UNDO_HISTORY_SHADOW_ENABLED", "GMAIL_HISTORY_SHADOW_PROOF_ENABLED", "GMAIL_SCALABLE_CLEANUP_DEV_ENABLED",
  "GMAIL_SCALABLE_POSTSTATE_AUDIT_ENABLED", "GMAIL_SCALABLE_WORKFLOW_ENABLED", "GMAIL_SCALABLE_WORKFLOW_FIXTURE_ENABLED",
  "MICROSOFT_OAUTH_DEV_ENABLED", "OUTLOOK_IMAP_BENCHMARK_DEV_ENABLED", "OUTLOOK_CLEANUP_DEV_ENABLED"
];

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

function production() {
  vi.stubEnv("NODE_ENV", "production");
  for (const [name, value] of Object.entries(configured)) vi.stubEnv(name, value);
}

describe("production configuration", () => {
  it("requires explicit independent production flags, not credentials or dev flags", () => {
    expect(resolveProductionProviders({})).toEqual({ gmail: false, microsoft: false });
    expect(resolveProductionProviders(configured)).toEqual({ gmail: true, microsoft: true });
    expect(resolveProductionProviders({ ...configured, GMAIL_PRODUCTION_ENABLED: undefined, MICROSOFT_PRODUCTION_ENABLED: undefined }))
      .toEqual({ gmail: false, microsoft: false });
    expect(resolveProductionProviders({ ...configured, GMAIL_PRODUCTION_ENABLED: "false" })).toEqual({ gmail: false, microsoft: true });
    expect(resolveProductionProviders({ ...configured, MICROSOFT_PRODUCTION_ENABLED: "false" })).toEqual({ gmail: true, microsoft: false });
  });

  it.each(["DATABASE_URL", "TOKEN_ENCRYPTION_KEY", "CLEANUP_STATE_ENCRYPTION_KEY", "CRON_SECRET", "NEXT_PUBLIC_APP_URL"])(
    "disables both providers without shared %s", (name) => {
      expect(resolveProductionProviders({ ...configured, [name]: undefined })).toEqual({ gmail: false, microsoft: false });
    }
  );

  it.each(["CLIENT_ID", "CLIENT_SECRET", "REDIRECT_URI"])("isolates missing OAuth %s to its provider", (suffix) => {
    expect(resolveProductionProviders({ ...configured, [`GOOGLE_${suffix}`]: "" })).toEqual({ gmail: false, microsoft: true });
    expect(resolveProductionProviders({ ...configured, [`MICROSOFT_${suffix}`]: "" })).toEqual({ gmail: true, microsoft: false });
  });

  it("rejects malformed encryption, database and callback configuration", () => {
    expect(resolveProductionProviders({ ...configured, TOKEN_ENCRYPTION_KEY: "short" }).gmail).toBe(false);
    expect(resolveProductionProviders({ ...configured, CLEANUP_STATE_ENCRYPTION_KEY: "short" }).gmail).toBe(false);
    expect(resolveProductionProviders({ ...configured, DATABASE_URL: "file:local.db" }).gmail).toBe(false);
    for (const redirect of ["http://example.test/api/oauth/google/callback", "https://wrong.test/api/oauth/google/callback", "https://example.test/wrong", "https://example.test/api/oauth/google/callback?code=private"]) {
      expect(resolveProductionProviders({ ...configured, GOOGLE_REDIRECT_URI: redirect })).toEqual({ gmail: false, microsoft: true });
    }
  });

  it.each([undefined, "true", "false"])("forces fixtures off in production even with fixture mode=%s", async (fixture) => {
    production();
    vi.stubEnv("ORGANIZINBOX_FIXTURE_MODE", fixture);
    for (const name of devFlags) vi.stubEnv(name, "true");
    vi.stubEnv("GMAIL_SCALABLE_STORE_ADAPTER", "memory");
    const { runtimeConfig, env } = await import("@/lib/config");
    expect(runtimeConfig.fixtureMode).toBe(false);
    if (fixture === undefined) expect(env.ORGANIZINBOX_FIXTURE_MODE).toBe("false");
    expect(runtimeConfig.gmailScalableStoreAdapter).toBe("prisma");
    for (const [name, value] of Object.entries(runtimeConfig)) {
      if (name.endsWith("Enabled")) expect(value, name).toBe(false);
    }
    expect(runtimeConfig.gmailAvailable).toBe(true);
    expect(runtimeConfig.microsoftAvailable).toBe(true);
  });

  it("disables invalid Microsoft authority without taking Gmail down", async () => {
    production();
    vi.stubEnv("MICROSOFT_TENANT_ID", "common/../consumers");
    const { runtimeConfig } = await import("@/lib/config");
    expect(runtimeConfig.gmailAvailable).toBe(true);
    expect(runtimeConfig.microsoftAvailable).toBe(false);
  });

  it("preserves explicitly enabled development fixtures and test gates", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ORGANIZINBOX_FIXTURE_MODE", "true");
    for (const name of devFlags) vi.stubEnv(name, "true");
    const { runtimeConfig } = await import("@/lib/config");
    expect(runtimeConfig.fixtureMode).toBe(true);
    expect(runtimeConfig.microsoftAvailable).toBe(true);
    expect(runtimeConfig.outlookImapBenchmarkDevEnabled).toBe(true);
    expect(runtimeConfig.gmailCleanupEnabled).toBe(true);
  });
});

describe("production UI and route boundaries", () => {
  it("blocks every development API before development handler work, allowing the billing denial boundary", async () => {
    production();
    const routes = readdirSync("app/api/dev", { recursive: true }).filter((name) => String(name).endsWith("route.ts"));
    expect(routes.length).toBeGreaterThanOrEqual(19);
    for (const name of routes) {
      const source = readFileSync(`app/api/dev/${name}`, "utf8");
      expect(source, String(name)).toMatch(/export async function (?:GET|POST)\([^)]*\) \{\s*(?:const denied = await productionCleanupBoundary\(request\);\s*if \(denied\) return denied;\s*)?if \(process.env.NODE_ENV === "production"\).*status: 404/);
    }
    const { POST } = await import("../app/api/dev/outlook-cleanup/undo/route");
    expect((await POST(new Request("https://example.test/api/dev/outlook-cleanup/undo", { method: "POST" }))).status).toBe(404);
    expect(work.undo).not.toHaveBeenCalled();
    expect(work.session).not.toHaveBeenCalled();
  });

  it("blocks disabled OAuth and scan endpoints before session, DB or network access", async () => {
    production();
    vi.stubEnv("GMAIL_PRODUCTION_ENABLED", "false");
    vi.stubEnv("MICROSOFT_PRODUCTION_ENABLED", "false");
    const fetch = vi.fn(() => { throw new Error("unexpected network"); });
    vi.stubGlobal("fetch", fetch);
    const googleStart = await import("../app/api/oauth/google/start/route");
    const googleCallback = await import("../app/api/oauth/google/callback/route");
    const microsoftStart = await import("../app/api/oauth/microsoft/start/route");
    const microsoftCallback = await import("../app/api/oauth/microsoft/callback/route");
    const gmailScan = await import("../app/api/app/gmail-scan/start/route");
    const microsoftScan = await import("../app/api/app/microsoft-scan/start/route");
    const { NextRequest } = await import("next/server");
    const request = new NextRequest("https://example.test/callback?code=never-process");
    expect((await googleStart.GET()).status).toBe(503);
    expect((await googleCallback.GET(request)).status).toBe(503);
    expect((await microsoftStart.GET()).status).toBe(404);
    expect((await microsoftCallback.GET(request)).status).toBe(404);
    expect((await gmailScan.POST()).status).toBe(503);
    expect((await microsoftScan.POST()).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    const { getAppHomeState, getPublicPrimaryCta } = await import("@/lib/server/app-state");
    expect(await getAppHomeState()).toEqual({ mode: "unavailable", provider: undefined });
    expect(await getPublicPrimaryCta("gmail")).toEqual({ href: "/connect", label: "View provider availability" });
    expect(work.session).not.toHaveBeenCalled();
    expect(work.scan).not.toHaveBeenCalled();
  });

  it("strips development scan diagnostics rather than hiding only their controls", async () => {
    production();
    const { createProgress, serializeScanProgress } = await import("@/lib/server/live-scan-store");
    const progress = createProgress({ scanId: "scan", provider: "microsoft", limit: "full", batchSize: 100 });
    progress.graphRequests = 123;
    progress.graphEvidenceAvailability = { categories: true } as typeof progress.graphEvidenceAvailability;
    progress.notes = ["private diagnostic"];
    progress.errors = ["internal development exception"];
    const publicProgress = serializeScanProgress(progress);
    expect(Object.keys(publicProgress).sort()).toEqual(["completedAt", "errors", "mailboxExists", "processed", "provider", "scanId", "startedAt", "status"].sort());
    expect(JSON.stringify(publicProgress)).not.toMatch(/diagnostic|exception|graphRequests|graphEvidence/);
  });

  it("blocks production mutation at the worker fence even with providers enabled", async () => {
    production();
    const { createCleanupRequestFence } = await import("@/lib/server/provider-work-fence");
    for (const provider of ["gmail", "microsoft"] as const) {
      await expect(createCleanupRequestFence({ id: "connection", userId: "owner", provider,
        sessionGeneration: "generation" }, "job", "worker", 1)()).rejects.toMatchObject({ name: "AbortError" });
    }
  });

  it("stops production scan workers when provider configuration is disabled", async () => {
    production();
    vi.stubEnv("GMAIL_PRODUCTION_ENABLED", "false");
    vi.stubEnv("MICROSOFT_PRODUCTION_ENABLED", "false");
    const { createScanRequestFence } = await import("@/lib/server/provider-work-fence");
    for (const provider of ["gmail", "microsoft"] as const) {
      await expect(createScanRequestFence("scan", "worker", provider)()).rejects.toMatchObject({ name: "AbortError" });
    }
  });

  it("keeps production secrets/config server-only and gates cleanup UI independently", () => {
    expect(readFileSync("src/lib/config.ts", "utf8")).toContain('import "server-only"');
    expect(readFileSync("src/lib/server/production-config.ts", "utf8")).not.toMatch(/NEXT_PUBLIC_(?:GMAIL|MICROSOFT|TOKEN|CLEANUP)/);
    expect(readFileSync("app/app/cleanup/page.tsx", "utf8")).toContain('getProductionCleanupUiState(true)');
    expect(readFileSync("src/components/product/InboxReportView.tsx", "utf8")).toContain('availability.access === "available" && !reportStale');
    expect(readFileSync("app/app/dev/gmail-benchmark/page.tsx", "utf8")).toContain('process.env.NODE_ENV === "production"');
    expect(readFileSync("app/api/oauth/microsoft/imap/start/route.ts", "utf8")).toContain('process.env.NODE_ENV === "production"');
  });
});
