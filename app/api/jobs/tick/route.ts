import postgres from "postgres";
import { cronAuthorised } from "@/src/lib/jobs/cron-auth";
import { createSummaryStore } from "@/src/lib/jobs/summary-store";
import { runSummaryJobs } from "@/src/lib/jobs/summary-runner";
import { createDeliveryStore } from "@/src/lib/alerts/delivery-store";
import { dispatchAlerts } from "@/src/lib/alerts/dispatch";
import { emailTransport, pushTransport, routedTransport } from "@/src/lib/alerts/transport";
import { syncDueIntegrations } from "@/src/lib/integrations/scheduled";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 32 || !process.env.DATABASE_URL) return Response.json({ error: "Scheduler is not configured." }, { status: 503, headers });
  if (!cronAuthorised(request.headers.get("authorization"), process.env.CRON_SECRET)) return Response.json({ error: "Unauthorised." }, { status: 401, headers });
  const db = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5, connection: { statement_timeout: 10000 } });
  try {
    // Deadlines get priority over a large historical import backlog.
    const urgent = await dispatchAlerts(createDeliveryStore(db), routedTransport(emailTransport(), pushTransport()), { budgetMs: 6000, limit: 5 });
    const integrations = await syncDueIntegrations(db, { limit: 3 });
    // One claim may fold in six adjacent days. Use the runner's tested maximum so
    // a normal historical import reaches Today within the next minute tick.
    const summaries = await runSummaryJobs(createSummaryStore(db), { limit: 20, timeBudgetMs: 50000 });
    const alerts = await dispatchAlerts(createDeliveryStore(db), routedTransport(emailTransport(), pushTransport()), { budgetMs: 12000, limit: 20 });
    return Response.json({ urgent, integrations, alerts, summaries }, { headers, status: urgent.failed || integrations.failed || alerts.failed || summaries.failed ? 503 : 200 });
  } catch { return Response.json({ error: "Job dispatch failed. Pending work is retained for retry." }, { status: 503, headers }); }
  finally { await db.end({ timeout: 5 }); }
}
// Vercel Cron sends authenticated GET; pg_net uses POST.
export const GET = POST;
