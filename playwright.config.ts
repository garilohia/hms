import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.HMS_TEST_PORT || 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("HMS_TEST_PORT must be a valid unprivileged port.");
const baseURL = "http://localhost:" + port;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run start -- --port " + port,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
