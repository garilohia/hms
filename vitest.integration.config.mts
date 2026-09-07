import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
// This explicit integration command may use the developer's database.
if (!process.env.DATABASE_URL && existsSync(".env.local")) process.loadEnvFile(".env.local");
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["tests/integration/**/*.test.ts"], fileParallelism: false, testTimeout: 30_000, hookTimeout: 120_000 },
});
