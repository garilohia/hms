import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
process.env.HMS_TEST_CRON_SECRET ||= randomUUID() + randomUUID();
export default defineConfig({ ...base, testDir: "./tests/alerts-live", outputDir: "./test-results/alerts", timeout: 120_000,
  // Full Chromium supports this check; headless-shell denied permission on this host.
  projects: [{ name: "chromium", use: { channel: "chromium", viewport: { width: 390, height: 844 } } }],
  use: { ...base.use, trace: "off", screenshot: "off", viewport: { width: 390, height: 844 } },
  webServer: { ...base.webServer, command: "npm run start -- --port " + (process.env.HMS_TEST_PORT || "3100"), url: String(base.use?.baseURL),
    env: { CRON_SECRET: process.env.HMS_TEST_CRON_SECRET, RESEND_API_KEY: "" } },
});
