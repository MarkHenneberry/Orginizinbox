import "server-only";

type Environment = Record<string, string | undefined>;

// Returns capabilities only. Never serialize the configuration or rejection details.
export function resolveProductionProviders(input: Environment) {
  const text = (name: string) => Boolean(input[name]?.trim());
  const key = (name: string) => {
    const value = input[name] ?? "";
    return Buffer.from(value, "base64").length === 32 || Buffer.byteLength(value, "utf8") === 32;
  };
  const httpsUrl = (value: string | undefined) => {
    try {
      const url = new URL(value ?? "");
      return url.protocol === "https:" && !url.username && !url.password ? url : undefined;
    } catch { return undefined; }
  };
  const app = httpsUrl(input.NEXT_PUBLIC_APP_URL);
  const callback = (name: string, path: string) => {
    const url = httpsUrl(input[name]);
    return Boolean(app && url && url.origin === app.origin && url.pathname === path && !url.search && !url.hash);
  };
  let database = false;
  try {
    const url = new URL(input.DATABASE_URL ?? "");
    database = Boolean(url.hostname) && (
      (["postgres:", "postgresql:"].includes(url.protocol) && url.pathname.length > 1) ||
      (["prisma:", "prisma+postgres:"].includes(url.protocol) && Boolean(url.searchParams.get("api_key")))
    );
  } catch { /* Invalid database configuration disables provider availability. */ }
  const shared = Boolean(app && database && key("TOKEN_ENCRYPTION_KEY") && key("CLEANUP_STATE_ENCRYPTION_KEY") && text("CRON_SECRET"));
  return {
    gmail: shared && input.GMAIL_PRODUCTION_ENABLED === "true" && text("GOOGLE_CLIENT_ID") && text("GOOGLE_CLIENT_SECRET") &&
      callback("GOOGLE_REDIRECT_URI", "/api/oauth/google/callback"),
    microsoft: shared && input.MICROSOFT_PRODUCTION_ENABLED === "true" && text("MICROSOFT_CLIENT_ID") && text("MICROSOFT_CLIENT_SECRET") &&
      callback("MICROSOFT_REDIRECT_URI", "/api/oauth/microsoft/callback")
  };
}
