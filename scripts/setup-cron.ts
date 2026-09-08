import nextEnv from "@next/env";
import postgres from "postgres";
import { cronCommand, cronEndpoint, cronJobName, cronSchedule } from "../src/lib/jobs/cron-config";
nextEnv.loadEnvConfig(process.cwd());
async function main() {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32 || !process.env.DATABASE_URL || !process.env.NEXT_PUBLIC_APP_URL) throw new Error("Configure DATABASE_URL, the deployed NEXT_PUBLIC_APP_URL and a random CRON_SECRET of at least 32 characters first.");
  const endpoint = cronEndpoint(process.env.NEXT_PUBLIC_APP_URL);
  const db = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await db.unsafe("create extension if not exists pg_cron");
    await db.unsafe("create extension if not exists pg_net");
    await db.unsafe("create extension if not exists supabase_vault");
    // Refuse installation if decrypted secrets would be exposed to API callers.
    const [privileges] = await db.unsafe("select has_table_privilege('anon','vault.decrypted_secrets','SELECT') or has_table_privilege('authenticated','vault.decrypted_secrets','SELECT') as exposed");
    if (privileges.exposed) throw new Error("Vault privileges require review before scheduling.");
    await db.begin(async tx => {
      for (const [name, value] of [["hms_job_url", endpoint], ["hms_cron_secret", secret]]) {
        const [existing] = await tx.unsafe("select id from vault.secrets where name=$1", [name]);
        if (existing) await tx.unsafe("select vault.update_secret($1,$2,$3)", [existing.id, value, name]);
        else await tx.unsafe("select vault.create_secret($1,$2)", [value, name]);
      }
      await tx.unsafe("select cron.schedule($1,$2,$3)", [cronJobName, cronSchedule, cronCommand]);
    });
    const [job] = await db.unsafe("select schedule,active from cron.job where jobname=$1", [cronJobName]);
    if (!job || job.schedule !== cronSchedule || !job.active) throw new Error("Cron configuration did not verify.");
    process.stdout.write("HMS dispatcher scheduled every minute. Verify successful HTTP responses after deployment; credentials were not printed.\n");
  } finally { await db.end(); }
}
main().catch(() => { process.stderr.write("Cron setup did not complete. Check the deployed URL, secret, database extensions and restricted Vault permissions.\n"); process.exitCode = 1; });
