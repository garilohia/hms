import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Use an explicit environment file so Preview tests cannot fall back to production data.
const envFile = process.env.HMS_DEPLOYED_ENV_FILE;
if (envFile) {
  if (!existsSync(envFile)) throw new Error("The deployment test environment file is missing.");
  process.loadEnvFile(envFile);
}
const baseURL = process.env.HMS_DEPLOYMENT_URL;
if (!baseURL || new URL(baseURL).protocol !== "https:") throw new Error("Set HMS_DEPLOYMENT_URL to the deployed HTTPS origin.");
const suite = process.env.HMS_DEPLOYED_SUITE ?? "e2e";
if (suite !== "e2e" && suite !== "golden") throw new Error("Choose the e2e or golden deployed suite.");

export default defineConfig({
  testDir: `./tests/${suite}`,
  outputDir: `./test-results/deployed-${suite}`,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  projects: [{ name: "deployed-chromium", use: { channel: "chromium", viewport: { width: 390, height: 844 } } }],
  use: { baseURL, actionTimeout: 20_000, navigationTimeout: 30_000, trace: "off", screenshot: "off" },
});
