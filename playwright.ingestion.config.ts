import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
export default defineConfig({ ...base, testDir: "./tests/ingestion-live", timeout: 900_000, workers: 1,
  outputDir: "./test-results/ingestion",
  use: { ...base.use, trace: "off", screenshot: "off" } });
