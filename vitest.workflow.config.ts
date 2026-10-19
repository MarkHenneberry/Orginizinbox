import { workflow } from "@workflow/vitest";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { isolatedTestDatabase } from "./scripts/test-database-config";

for (const [key, value] of Object.entries(loadEnv("test", process.cwd(), ""))) {
  process.env[key] ??= value;
}
process.env.DATABASE_URL = isolatedTestDatabase(process.env);

export default defineConfig({
  plugins: [workflow()],
  test: {
    environment: "node",
    include: ["tests/**/*.workflow-integration.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 120_000,
    testTimeout: 120_000
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "server-only": new URL("./tests/server-only.ts", import.meta.url).pathname
    }
  }
});
