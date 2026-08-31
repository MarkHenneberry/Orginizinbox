import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("https://organizinbox.com"),
  ORGANIZINBOX_FIXTURE_MODE: z.enum(["true", "false"]).default("true"),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GMAIL_BENCHMARK_ENABLED: z.enum(["true", "false"]).default("false"),
  GMAIL_CLEANUP_ENABLED: z.enum(["true", "false"]).default("false"),
  GMAIL_CLEANUP_MAX_MESSAGES: z.coerce.number().int().min(1).max(100).default(5),
  GMAIL_CLEANUP_RECHECK_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(8),
  GMAIL_BULK_UNDO_PROOF_ENABLED: z.enum(["true", "false"]).default("false"),
  GMAIL_BULK_UNDO_HISTORY_SHADOW_ENABLED: z.enum(["true", "false"]).default("false"),
  GMAIL_HISTORY_SHADOW_PROOF_ENABLED: z.enum(["true", "false"]).default("false"),
  GMAIL_SCALABLE_CLEANUP_DEV_ENABLED: z.enum(["true", "false"]).default("false"),
  GMAIL_SCALABLE_POSTSTATE_AUDIT_ENABLED: z.enum(["true", "false"]).default("false"),
  GMAIL_SCALABLE_WORKFLOW_ENABLED: z.enum(["true", "false"]).default("false"),
  GMAIL_SCALABLE_WORKFLOW_FIXTURE_ENABLED: z.enum(["true", "false"]).default("false"),
  GMAIL_SCALABLE_STORE_ADAPTER: z.enum(["memory", "prisma"]).optional(),
  CLEANUP_STATE_ENCRYPTION_KEY: z.string().optional(),
  CLEANUP_STATE_ACTIVE_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(1800),
  CLEANUP_STATE_UNDO_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(1800),
  CLEANUP_STATE_TERMINAL_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(60),
  CLEANUP_STATE_LOCK_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GMAIL_IMAP_HOST: z.string().default("imap.gmail.com"),
  GMAIL_IMAP_PORT: z.coerce.number().default(993),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default("common"),
  MICROSOFT_REDIRECT_URI: z.string().optional(),
  MICROSOFT_OAUTH_DEV_ENABLED: z.enum(["true", "false"]).default("false"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PRICE_FULL_RESET_USD: z.string().optional()
});

export const env = envSchema.parse(process.env);

export const siteConfig = {
  name: "Organizinbox",
  domain: "organizinbox.com",
  url: env.NEXT_PUBLIC_APP_URL,
  description: "See what's clogging your inbox and safely move unwanted Gmail or Outlook messages to Trash.",
  logoPath: "/images/oi-logo.png"
};

export const pricingConfig = {
  freeScan: {
    label: "Free Inbox Scan",
    priceCents: 0,
    cleanupAllowance: 500
  },
  fullReset: {
    label: "Full Inbox Reset",
    priceCents: 999,
    currency: "USD"
  }
};

export const runtimeConfig = {
  fixtureMode: env.ORGANIZINBOX_FIXTURE_MODE === "true",
  gmailBenchmarkEnabled: env.GMAIL_BENCHMARK_ENABLED === "true",
  gmailCleanupEnabled: env.GMAIL_CLEANUP_ENABLED === "true",
  gmailCleanupMaxMessages: Math.min(env.GMAIL_CLEANUP_MAX_MESSAGES, 100),
  gmailCleanupRecheckConcurrency: env.GMAIL_CLEANUP_RECHECK_CONCURRENCY,
  gmailBulkUndoProofEnabled: env.GMAIL_BULK_UNDO_PROOF_ENABLED === "true",
  gmailBulkUndoHistoryShadowEnabled: env.GMAIL_BULK_UNDO_HISTORY_SHADOW_ENABLED === "true",
  gmailHistoryShadowProofEnabled: env.GMAIL_HISTORY_SHADOW_PROOF_ENABLED === "true",
  gmailScalableCleanupDevEnabled: env.GMAIL_SCALABLE_CLEANUP_DEV_ENABLED === "true",
  gmailScalablePostStateAuditEnabled: env.GMAIL_SCALABLE_POSTSTATE_AUDIT_ENABLED === "true",
  gmailScalableWorkflowEnabled: env.GMAIL_SCALABLE_WORKFLOW_ENABLED === "true",
  gmailScalableWorkflowFixtureEnabled: env.GMAIL_SCALABLE_WORKFLOW_FIXTURE_ENABLED === "true",
  gmailScalableStoreAdapter: env.GMAIL_SCALABLE_STORE_ADAPTER ?? (process.env.NODE_ENV === "production" ? "prisma" : "memory"),
  cleanupStateActiveTtlSeconds: env.CLEANUP_STATE_ACTIVE_TTL_SECONDS,
  cleanupStateUndoTtlSeconds: env.CLEANUP_STATE_UNDO_TTL_SECONDS,
  cleanupStateTerminalTtlSeconds: env.CLEANUP_STATE_TERMINAL_TTL_SECONDS,
  cleanupStateLockTtlSeconds: env.CLEANUP_STATE_LOCK_TTL_SECONDS,
  microsoftOAuthDevEnabled: env.MICROSOFT_OAUTH_DEV_ENABLED === "true"
};

export function requireGoogleOAuthConfig() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new ConfigurationError("Google OAuth is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.");
  }
}

export function requireMicrosoftOAuthConfig() {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REDIRECT_URI) {
    throw new ConfigurationError(
      "Microsoft OAuth is not configured. Add MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REDIRECT_URI."
    );
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}
