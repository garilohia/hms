import "server-only";
import postgres from "postgres";
import { createDeliveryStore } from "../alerts/delivery-store";
import { dispatchAlerts } from "../alerts/dispatch";
import { emailTransport, pushTransport, routedTransport } from "../alerts/transport";
import { runSummaryJobs } from "./summary-runner";
import { createSummaryStore } from "./summary-store";

/**
 * Fast path for fresh device readings. The durable summary/outbox rows remain the
 * source of truth, so a timeout or deployment interruption is retried by cron.
 */
export async function processFreshHealthData(actor: string, subject: string) {
  if (!process.env.DATABASE_URL) return { state: "queued" as const };
  const db = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5, connection: { statement_timeout: 12_000 }, onnotice() {} });
  try {
    const summaries = await runSummaryJobs(createSummaryStore(db, { actor, subject }), { limit: 1, timeBudgetMs: 8_000 });
    const notifications = await dispatchAlerts(createDeliveryStore(db), routedTransport(emailTransport(), pushTransport()), { limit: 20, budgetMs: 6_000 });
    return { state: "processed" as const, summaries, notifications };
  } finally {
    await db.end({ timeout: 3 });
  }
}
