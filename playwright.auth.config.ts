import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
export default defineConfig({ ...base, testDir: "./tests/auth-live", outputDir: "./test-results/auth", timeout: 60_000, use: { ...base.use, trace: "off", screenshot: "off" } });
