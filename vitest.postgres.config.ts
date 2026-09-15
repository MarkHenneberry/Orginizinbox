import nextEnv from "@next/env";
import { defineConfig } from "vitest/config";

// Vitest sets NODE_ENV=test before loading config; Next otherwise skips .env.local.
Object.assign(process.env, { NODE_ENV: "development" });
nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
if (!process.env.DATABASE_URL) throw new Error("Development DATABASE_URL is required for Postgres integration tests.");
Object.assign(process.env, {
  NODE_ENV: "test", ORGANIZINBOX_FIXTURE_MODE: "false",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 74).toString("base64"),
  CLEANUP_STATE_ENCRYPTION_KEY: Buffer.alloc(32, 73).toString("base64"),
  MICROSOFT_OAUTH_DEV_ENABLED: "true", OUTLOOK_CLEANUP_DEV_ENABLED: "true",
  GMAIL_SCALABLE_STORE_ADAPTER: "prisma", GMAIL_SCALABLE_CLEANUP_DEV_ENABLED: "true"
});

export default defineConfig({
  test: {
    environment: "node", include: ["tests/**/*.postgres-integration.ts"],
    setupFiles: ["./tests/fixtures/postgres-network-guard.ts"],
    fileParallelism: false, maxWorkers: 1, testTimeout: 60_000, hookTimeout: 60_000
  },
  resolve: { alias: {
    "@": new URL("./src", import.meta.url).pathname,
    "server-only": new URL("./tests/server-only.ts", import.meta.url).pathname
  } }
});
