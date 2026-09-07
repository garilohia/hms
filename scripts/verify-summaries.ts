import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import postgres from "postgres";
import { dailySummary, deriveHistory, periodsFromFlows, type Metric } from "../src/lib/analytics";
import { localDay } from "../src/lib/analytics/time";

loadEnvConfig(process.cwd());
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const db = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    // Read only the three explicitly marked, reserved-domain synthetic fixtures.
    for (const persona of ["a", "b", "c"]) {
      const [profile] = await db.unsafe("select p.id,p.timezone from public.profiles p join auth.users u on u.id=p.auth_user_id where u.email=$1 and u.raw_app_meta_data->>'hms_seed'='true' and u.raw_app_meta_data->>'hms_seed_version'='2'", ["hms-sample-" + persona + "@example.invalid"]);
      assert.ok(profile, "Run the current sample seed first.");
      const raw = await db.unsafe("select m.*,s.provider from public.metrics m join public.data_sources s on s.id=m.source_id where m.user_id=$1 order by m.recorded_at,m.id", [profile.id]);
      assert.ok(raw.every(row => row.provider === "simulator"));
      const metrics: Metric[] = raw.map(row => ({ metric_type: row.metric_type, value: Number(row.value), unit: row.unit, recorded_at: row.recorded_at.toISOString(), duration_s: row.duration_s, quality: row.quality, source_id: row.source_id, is_sample: true }));
      const days = [...new Set(metrics.map(m => localDay(m.recorded_at, profile.timezone)))].sort();
      assert.equal(days.length, 90);
      const periods = periodsFromFlows(metrics.filter(m => m.metric_type === "menstrual_flow").map(m => ({ day: localDay(m.recorded_at, profile.timezone), value: m.value })));
      const expected = deriveHistory(days.map(day => dailySummary(metrics, { day, timezone: profile.timezone })), periods);
      const actual = await db.unsafe("select s.*,s.day::text as day from public.daily_summaries s where s.user_id=$1 order by s.day", [profile.id]);
      assert.equal(actual.length, 90);
      for (let i = 0; i < actual.length; i++) {
        assert.equal(actual[i].day, expected.summaries[i].day);
        for (const field of ["rhr", "hrv_avg", "night_spo2_min", "skin_temp_deviation", "sleep_duration_min", "recovery_score", "readiness_score"] as const) {
          const want = expected.summaries[i][field], got = actual[i][field];
          if (want === null) assert.equal(got, null, field);
          else assert.ok(Math.abs(Number(got) - want) < 1e-8, persona + ": " + actual[i].day + " " + field);
        }
        assert.equal(actual[i].contains_sample, true);
      }
      const pending = await db.unsafe("select id from public.summary_jobs where user_id=$1 and revision>processed_revision", [profile.id]);
      assert.equal(pending.length, 0, "Drain pending summaries first.");
      const baselines = await db.unsafe("select metric_type,median,mad,sample_count from public.baselines where user_id=$1", [profile.id]);
      for (const row of baselines) {
        const baseline = expected.baselines[row.metric_type as Metric["metric_type"]];
        assert.ok(baseline);
        assert.equal(Number(row.median), baseline.median);
        assert.equal(Number(row.mad), baseline.mad);
        assert.equal(row.sample_count, baseline.n);
      }
      const insights = await db.unsafe("select category,title from public.insights where user_id=$1 and resolved_at is null and insight_key like 'engine:%'", [profile.id]);
      assert.deepEqual(insights.map(i => i.title).sort(), expected.insights.map(i => i.title).sort());
      if (persona === "b") assert.ok(insights.some(i => i.category === "cycle"));
      if (persona === "c") assert.ok(insights.some(i => i.title === "Your body shows signs of strain."));
      process.stdout.write(JSON.stringify({ persona, metrics: raw.length, days: actual.length, baselines: baselines.length, insights: insights.length, readiness: actual.at(-1)?.readiness_score, pending: 0 }) + "\n");
    }
  } finally { await db.end(); }
}
main().catch(error => { process.stderr.write(error instanceof Error ? error.message + "\n" : "Summary verification failed.\n"); process.exitCode = 1; });
