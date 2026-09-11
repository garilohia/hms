export type SummaryJob = { id: string; userId: string; day: string; token: string; attempts: number; rebucket?: boolean };
export interface SummaryJobStore {
  claim(now: Date): Promise<SummaryJob | null>;
  process(job: SummaryJob, now: Date): Promise<number | "stale" | "withheld">;
  retry(job: SummaryJob, now: Date, error: string): Promise<void>;
}
export async function runSummaryJobs(store: SummaryJobStore, options: { limit?: number; timeBudgetMs?: number; clock?: () => Date } = {}) {
  const limit = Math.max(1, Math.min(20, options.limit ?? 10));
  const budget = Math.max(1, Math.min(50_000, options.timeBudgetMs ?? 45_000));
  const clock = options.clock || (() => new Date());
  const started = performance.now();
  const result = { completed: 0, failed: 0, stale: 0, withheld: 0 };
  for (let i = 0; i < limit && performance.now() - started < budget; i++) {
    const job = await store.claim(clock());
    if (!job) break;
    try {
      const outcome = await store.process(job, clock());
      if (typeof outcome === "number") result.completed += outcome; else result[outcome]++;
    }
    catch (error) {
      // Never log patient values or connection strings in retry state.
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.name : "UnknownError";
      await store.retry(job, clock(), code.slice(0, 80)); result.failed++;
    }
  }
  return result;
}
