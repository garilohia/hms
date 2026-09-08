import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { dailySummary, deriveHistory, periodsFromFlows, type DailySummary, type Metric, type PeriodLog } from "../analytics";
import { addDays, dayBounds, localDay } from "../analytics/time";
import { metricTypes } from "../ingestion/model";
import type { SummaryJob, SummaryJobStore } from "./summary-runner";
import { persistAlerts } from "../alerts/persist";

type Executor = Pick<postgres.Sql, "unsafe">;
type Transaction = <T>(work: (tx: Executor) => Promise<T>) => Promise<T>;
const numeric = z.union([z.number(), z.string()]).transform(Number).refine(Number.isFinite).nullable();
const numericFields = ["rhr", "hrv_avg", "spo2_min", "spo2_avg", "night_spo2_min", "skin_temp_avg", "skin_temp_deviation", "sleep_duration_min", "sleep_efficiency", "deep_min", "rem_min", "steps", "active_calories", "stress_avg", "weight_kg", "bp_systolic", "bp_diastolic", "recovery_score", "readiness_score"] as const;
const summaryParser = z.object({
  day: z.string(), ...Object.fromEntries(numericFields.map(f => [f, numeric])), contains_sample: z.boolean(),
  source_ids: z.partialRecord(z.enum(metricTypes), z.string()), metric_values: z.partialRecord(z.enum(metricTypes), z.number()),
});
const metricParser = z.object({ metric_type: z.enum(metricTypes), value: numeric.refine(v => v !== null), unit: z.string(), recorded_at: z.coerce.date().transform(d => d.toISOString()),
  duration_s: z.number().nullable(), at_rest: z.boolean().nullable(), quality: z.enum(["raw", "derived", "user_entered"]), source_id: z.uuid(), is_sample: z.boolean() });

export class PostgresSummaryStore implements SummaryJobStore {
  private transaction: Transaction;
  private table: (name: string) => string;
  constructor(private db: Executor, options: { transaction: Transaction; schema?: string }) {
    const schema = options.schema || "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid internal schema name.");
    this.table = name => '"' + schema + '"."' + name + '"';
    this.transaction = options.transaction;
  }
  async claim(now: Date): Promise<SummaryJob | null> {
    const t = this.table;
    return this.transaction(async tx => {
      const [job] = await tx.unsafe("select j.id,j.user_id,j.day::text,j.attempts from " + t("summary_jobs") + " j join " + t("profiles") + " p on p.id=j.user_id where j.revision>j.processed_revision and j.available_at<=$1 and (j.locked_until is null or j.locked_until<=$1) and exists (select 1 from " + t("consents") + " c where c.user_id=j.user_id and c.consent_type='data_ingestion' and c.revoked_at is null) order by j.day,j.id limit 1 for update of j skip locked", [now]);
      if (!job) return null;
      const token = randomUUID();
      await tx.unsafe("update " + t("summary_jobs") + " set lease_token=$1,locked_until=$2,attempts=attempts+1 where id=$3", [token, new Date(now.getTime() + 120000), job.id]);
      return { id: String(job.id), userId: String(job.user_id), day: String(job.day), attempts: Number(job.attempts) + 1, token };
    });
  }
  async retry(job: SummaryJob, now: Date, error: string) {
    const delay = Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7));
    await this.db.unsafe("update " + this.table("summary_jobs") + " set lease_token=null,locked_until=null,last_error=$1,available_at=$2 where id=$3 and lease_token=$4", [error, new Date(now.getTime() + delay * 1000), job.id, job.token]);
  }
  async process(job: SummaryJob, now: Date): Promise<number | "stale" | "withheld"> {
    const t = this.table;
    return this.transaction(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='45s'");
      // Match ingestion's profile -> job lock order. Claims commit their short
      // transaction before this step, avoiding a profile/job deadlock.
      const [profile] = await tx.unsafe("select id,timezone,local_emergency_number,owner_account_id from " + t("profiles") + " where id=$1 for update", [job.userId]);
      if (!profile) return "stale";
      const [current] = await tx.unsafe("select revision from " + t("summary_jobs") + " where id=$1 and lease_token=$2 for update", [job.id, job.token]);
      if (!current) return "stale";
      const consent = await tx.unsafe("select 1 from " + t("consents") + " where user_id=$1 and consent_type='data_ingestion' and revoked_at is null", [job.userId]);
      if (!consent.length) {
        await tx.unsafe("update " + t("summary_jobs") + " set lease_token=null,locked_until=null where id=$1 and lease_token=$2", [job.id, job.token]);
        return "withheld";
      }
      // Coalesce up to seven nearby pending days under the same profile lock.
      // This avoids repeating baseline/history round trips for every sample day.
      // An expensive/failed batch retries as one day; never span arbitrary years.
      const extra = job.attempts > 1 ? [] : await tx.unsafe("select id,day::text,revision from " + t("summary_jobs") + " where user_id=$1 and id<>$2 and revision>processed_revision and available_at<=$3 and (locked_until is null or locked_until<=$3) and day>=$4 and day<=$5 order by day,id limit 6 for update skip locked", [job.userId, job.id, now, job.day, addDays(job.day, 6)]);
      const work = [{ id: job.id, day: job.day, revision: Number(current.revision) }, ...extra.map(j => ({ id: String(j.id), day: String(j.day), revision: Number(j.revision) }))].sort((a, b) => a.day.localeCompare(b.day));
      const timezone = String(profile.timezone), bounds = { start: dayBounds(work[0].day, timezone).start, end: dayBounds(work.at(-1)!.day, timezone).end };
      // Bounded calendar span plus intervals crossing its first midnight.
      const raw = await tx.unsafe("select m.metric_type,m.value::text,m.unit,m.recorded_at,m.duration_s,m.at_rest,m.quality,m.source_id,(s.provider='simulator') as is_sample from " + t("metrics") + " m join " + t("data_sources") + " s on s.id=m.source_id where m.user_id=$1 and m.recorded_at<$2 and m.recorded_at>=$3 and m.recorded_at+coalesce(m.duration_s,0)*interval '1 second'>=$4 order by m.recorded_at,m.id", [job.userId, new Date(bounds.end), new Date(bounds.start - 604800000), new Date(bounds.start - 86400000)]);
      const metrics: Metric[] = raw.map(row => metricParser.parse(row));
      const days = work.map(j => dailySummary(metrics, { day: j.day, timezone }));
      const previous = await tx.unsafe("select s.*,s.day::text as day from " + t("daily_summaries") + " s where s.user_id=$1 order by s.day", [job.userId]);
      const summaries = previous.map(row => summaryParser.parse(row) as DailySummary).filter(row => !work.some(j => j.day === row.day));
      summaries.push(...days);
      const logs = await tx.unsafe("select period_start::text as start,period_end::text as end from " + t("cycle_logs") + " where user_id=$1 and origin='manual' and period_start is not null", [job.userId]);
      const manual = z.array(z.object({ start: z.string(), end: z.string().nullable() })).parse(logs);
      const flow = await tx.unsafe("select recorded_at,value::text as value from " + t("metrics") + " where user_id=$1 and metric_type='menstrual_flow' and quality='user_entered' order by recorded_at", [job.userId]);
      const imported = periodsFromFlows(flow.map(r => ({ day: localDay(r.recorded_at instanceof Date ? r.recorded_at.getTime() : String(r.recorded_at), timezone), value: Number(r.value) })));
      const periods: PeriodLog[] = [...new Map([...imported, ...manual].map(p => [p.start, p])).values()];
      const derived = deriveHistory(summaries, periods);
      await persistAlerts(tx, t, { id: job.userId, timezone, local_emergency_number: String(profile.local_emergency_number), owner_account_id: String(profile.owner_account_id) }, work.map(j => j.day), metrics, summaries, now);
      const fields = [...numericFields, "contains_sample", "source_ids", "metric_values", "recovery_evidence"];
      const jsonFields = ["source_ids", "metric_values", "recovery_evidence"];
      // A historical change affects its own row and the following 28 baselines.
      const changed = derived.summaries.filter(d => d.day >= job.day && d.day <= addDays(work.at(-1)!.day, 28)).map(d => ({ ...d, recovery_evidence: derived.evidence.get(d.day) }));
      await tx.unsafe("insert into " + t("daily_summaries") + "(user_id,day," + fields.join(",") + ",computed_at) select $1::uuid,(j->>'day')::date," + fields.map(f => jsonFields.includes(f) ? "j->'" + f + "'" : "(j->>'" + f + "')::" + (f === "contains_sample" ? "boolean" : "numeric")).join(",") + ",$3::timestamptz from jsonb_array_elements($2::text::jsonb) j on conflict(user_id,day) do update set " + fields.map(f => f + "=excluded." + f).join(",") + ",computed_at=excluded.computed_at", [job.userId, JSON.stringify(changed), now]);
      const endDay = derived.summaries.at(-1)?.day;
      await tx.unsafe("delete from " + t("baselines") + " where user_id=$1", [job.userId]);
      const baselineRows = Object.entries(derived.baselines).filter(([, b]) => b && b.n > 0 && b.median !== null && b.mad !== null).map(([type, b]) => ({ metric_type: type, ...b }));
      if (baselineRows.length) await tx.unsafe("insert into " + t("baselines") + "(user_id,metric_type,median,mad,sample_count,computed_at,window_end) select $1::uuid,(j->>'metric_type')::" + t("metric_type") + ",(j->>'median')::numeric,(j->>'mad')::numeric,(j->>'n')::int,$3::timestamptz,$4::date from jsonb_array_elements($2::text::jsonb) j", [job.userId, JSON.stringify(baselineRows), now, endDay ? addDays(endDay, -1) : null]);
      const cycle = derived.phases.map(p => {
        const period = periods.find(log => log.start === p.day);
        return { ...p, period_start: period?.start || null, period_end: period?.end || null, origin: period ? manual.some(m => m.start === period.start) ? "manual" : "import" : "inferred" };
      });
      if (cycle.length) await tx.unsafe("insert into " + t("cycle_logs") + "(user_id,day,period_start,period_end,phase,is_inferred,confidence,origin) select $1::uuid,(j->>'day')::date,(j->>'period_start')::date,(j->>'period_end')::date,j->>'phase',(j->>'is_inferred')::boolean,(j->>'confidence')::" + t("confidence") + ",j->>'origin' from jsonb_array_elements($2::text::jsonb) j on conflict(user_id,day) do update set phase=excluded.phase,is_inferred=excluded.is_inferred,confidence=excluded.confidence,period_start=case when " + t("cycle_logs") + ".origin='manual' then " + t("cycle_logs") + ".period_start else excluded.period_start end,period_end=case when " + t("cycle_logs") + ".origin='manual' then " + t("cycle_logs") + ".period_end else excluded.period_end end,origin=case when " + t("cycle_logs") + ".origin='manual' then 'manual' else excluded.origin end", [job.userId, JSON.stringify(cycle)]);
      const insights = derived.insights.map(i => ({ ...i, key: "engine:" + endDay + ":" + i.category + ":" + i.title }));
      await tx.unsafe("update " + t("insights") + " set resolved_at=$2 where user_id=$1 and insight_key like 'engine:%' and resolved_at is null and not (insight_key=any($3::text[]))", [job.userId, now, insights.map(i => i.key)]);
      if (insights.length) await tx.unsafe("insert into " + t("insights") + "(user_id,category,title,body,evidence,confidence,insight_key,created_at) select $1::uuid,j->>'category',j->>'title',j->>'body',j->'evidence',(j->>'confidence')::" + t("confidence") + ",j->>'key',$3::timestamptz from jsonb_array_elements($2::text::jsonb) j on conflict(user_id,insight_key) do update set body=excluded.body,evidence=excluded.evidence,confidence=excluded.confidence,resolved_at=null", [job.userId, JSON.stringify(insights), now]);
      await tx.unsafe("insert into " + t("audit_log") + "(action,target_user_id,target_table,target_id,metadata) select 'system_summary_read',$1::uuid,'analytics_inputs',(j->>'id')::uuid,jsonb_build_object('day',j->>'day','batch_metric_rows',$3::int) from jsonb_array_elements($2::text::jsonb) j", [job.userId, JSON.stringify(work), metrics.length]);
      await tx.unsafe("update " + t("summary_jobs") + " j set processed_revision=w.revision,lease_token=null,locked_until=null,last_error=null,attempts=0 from jsonb_to_recordset($1::text::jsonb) as w(id uuid,revision integer) where j.id=w.id", [JSON.stringify(work)]);
      return work.length;
    });
  }
}

export function createSummaryStore(db: postgres.Sql) {
  return new PostgresSummaryStore(db, { transaction: <T>(work: (tx: Executor) => Promise<T>) => db.begin(tx => work(tx)) as Promise<T> });
}
