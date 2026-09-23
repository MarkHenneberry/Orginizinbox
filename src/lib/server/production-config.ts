import "server-only";

type Environment = Record<string, string | undefined>;

// Fixed check names and booleans only; never expose configuration values.
export function productionProviderChecks(input: Environment) {
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
  const shared = {
    NEXT_PUBLIC_APP_URL: Boolean(app),
    DATABASE_URL: database,
    TOKEN_ENCRYPTION_KEY: key("TOKEN_ENCRYPTION_KEY"),
    CLEANUP_STATE_ENCRYPTION_KEY: key("CLEANUP_STATE_ENCRYPTION_KEY"),
    CRON_SECRET: text("CRON_SECRET")
  };
  return {
    gmail: {
      ...shared,
      GMAIL_PRODUCTION_ENABLED: input.GMAIL_PRODUCTION_ENABLED === "true",
      GOOGLE_CLIENT_ID: text("GOOGLE_CLIENT_ID"),
      GOOGLE_CLIENT_SECRET: text("GOOGLE_CLIENT_SECRET"),
      GOOGLE_REDIRECT_URI: callback("GOOGLE_REDIRECT_URI", "/api/oauth/google/callback")
    },
    microsoft: {
      ...shared,
      MICROSOFT_PRODUCTION_ENABLED: input.MICROSOFT_PRODUCTION_ENABLED === "true",
      MICROSOFT_CLIENT_ID: text("MICROSOFT_CLIENT_ID"),
      MICROSOFT_CLIENT_SECRET: text("MICROSOFT_CLIENT_SECRET"),
      MICROSOFT_REDIRECT_URI: callback("MICROSOFT_REDIRECT_URI", "/api/oauth/microsoft/callback")
    }
  };
}

export function resolveProductionProviders(input: Environment) {
  const checks = productionProviderChecks(input);
  return {
    gmail: Object.values(checks.gmail).every(Boolean),
    microsoft: Object.values(checks.microsoft).every(Boolean)
  };
}
