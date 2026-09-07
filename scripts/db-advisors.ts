import { spawn } from "node:child_process";
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const password = new URL(url).password;
const redact = (value: string) => {
  let result = value.replaceAll(url, "[database URL redacted]");
  if (password) result = result.replaceAll(password, "[redacted]").replaceAll(decodeURIComponent(password), "[redacted]");
  return result;
};
const child = spawn("npx", ["--yes", "supabase", "db", "advisors", "--db-url", url, "--type", "all", "--level", "warn", "--fail-on", "error"], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk: Buffer) => process.stdout.write(redact(chunk.toString())));
child.stderr.on("data", (chunk: Buffer) => process.stderr.write(redact(chunk.toString())));
child.on("error", () => { process.stderr.write("Could not start database advisors.\n"); process.exitCode = 1; });
child.on("close", code => { process.exitCode = code ?? 1; });
