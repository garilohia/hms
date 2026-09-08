import postgres from "postgres";
import { cronAuthorised } from "@/src/lib/jobs/cron-auth";
import { createSummaryStore } from "@/src/lib/jobs/summary-store";
import { runSummaryJobs } from "@/src/lib/jobs/summary-runner";
import { createDeliveryStore } from "@/src/lib/alerts/delivery-store";
import { dispatchAlerts } from "@/src/lib/alerts/dispatch";
import { emailTransport } from "@/src/lib/alerts/transport";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 32 || !process.env.DATABASE_URL) return Response.json({ error: "Scheduler is not configured." }, { status: 503, headers });
  if (!cronAuthorised(request.headers.get("authorization"), process.env.CRON_SECRET)) return Response.json({ error: "Unauthorised." }, { status: 401, headers });
  const db = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5, connection: { statement_timeout: 10000 } });
  try {
    // Deadlines get priority over a large historical import backlog.
    const alerts = await dispatchAlerts(createDeliveryStore(db), emailTransport(), { budgetMs: 15000, limit: 10 });
    const summaries = await runSummaryJobs(createSummaryStore(db), { limit: 3, timeBudgetMs: 20000 });
    return Response.json({ alerts, summaries }, { headers, status: alerts.failed || summaries.failed ? 503 : 200 });
  } catch { return Response.json({ error: "Job dispatch failed. Pending work is retained for retry." }, { status: 503, headers }); }
  finally { await db.end({ timeout: 5 }); }
}
// Vercel Cron sends authenticated GET; pg_net uses POST.
export const GET = POST;
