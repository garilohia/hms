import { loadEnvConfig } from "@next/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
loadEnvConfig(process.cwd());
async function main() {
  const input = process.env.DATABASE_URL;
  if (!input) throw new Error("DATABASE_URL is required.");
  const url = new URL(input);
  if (!["localhost","127.0.0.1","[::1]"].includes(url.hostname) || url.pathname !== "/hms_test" || process.env.HMS_ALLOW_DB_RESET !== "1") {
    throw new Error("Reset is restricted to an explicit local hms_test database with HMS_ALLOW_DB_RESET=1.");
  }
  const db=postgres(input,{max:1,prepare:false});
  try {
    await db.unsafe("drop schema if exists public cascade; drop schema if exists hms_private cascade; drop schema if exists drizzle cascade; create schema public;");
    await migrate(drizzle(db),{migrationsFolder:"./drizzle"});
    process.stdout.write("Local hms_test schema reset and migrated.\n");
  } finally { await db.end(); }
}
main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error && error.message.startsWith("Reset is restricted") ? error.message + "\n" : "Database reset failed.\n");
  process.exitCode=1;
});
