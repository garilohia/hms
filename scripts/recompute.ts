import nextEnv from "@next/env";
import postgres from "postgres";
import { createSummaryStore } from "../src/lib/jobs/summary-store";
import { runSummaryJobs } from "../src/lib/jobs/summary-runner";

nextEnv.loadEnvConfig(process.cwd());
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const db = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
  try {
    const store = createSummaryStore(db);
    let completed = 0;
    // The CLI drains batches for explicit setup/verification. Each server-facing
    // invocation remains limited to 20 batches (at most seven days each) and a
    // 50-second dispatch budget. Failed batches retry one day at a time.
    while (true) {
      const result = await runSummaryJobs(store, { limit: 20 });
      completed += result.completed;
      process.stdout.write(JSON.stringify({ ...result, completedTotal: completed }) + "\n");
      if (result.failed) throw new Error("Summary jobs failed. Inspect the bounded retry state in summary_jobs.");
      if (!result.completed && !result.stale) break;
    }
  } finally { await db.end(); }
}
main().catch(error => { process.stderr.write(error instanceof Error ? error.message + "\n" : "Summary recomputation failed.\n"); process.exitCode = 1; });
