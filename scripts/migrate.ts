import nextEnv from "@next/env";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

nextEnv.loadEnvConfig(process.cwd());
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 10 });
  try {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    process.stdout.write("Migrations applied.\n");
  } finally { await client.end(); }
}
main().catch((error: unknown) => {
  // Connection errors may contain credentials; report the code, never the URL.
  process.stderr.write("Migration failed: " + (error instanceof Error ? error.name : "unknown error") + "\n");
  process.exitCode = 1;
});
