import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normaliseApple } from "../../src/lib/ingestion/apple-normalise";
import { PostgresSummaryStore } from "../../src/lib/jobs/summary-store";
import { runSummaryJobs } from "../../src/lib/jobs/summary-runner";
import { PostgresDeliveryStore } from "../../src/lib/alerts/delivery-store";
import { dispatchAlerts } from "../../src/lib/alerts/dispatch";
import { defaultRules } from "../../src/lib/alerts/rules";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database verification.");
const db = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 10, onnotice() {} });
let cx: postgres.ReservedSql;
const suffix = randomUUID().replaceAll("-", "");
const schema = "hms_verify_" + suffix;
const privateSchema = schema + "_private";
const actors = { alice: randomUUID(), bob: randomUUID(), doctor: randomUUID(), guardian: randomUUID() };
const subjects: Record<string, string> = {};
const source = randomUUID();
const hash = "0".repeat(64);
const q = (query: string, values: (string | number | null)[] = []) => cx.unsafe(query, values);
const t = (name: string) => '"' + schema + '".' + name;
const fn = (name: string) => t("hms_" + name);
async function actAs(actor: string) {
  await q("SET LOCAL ROLE authenticated");
  await q("select set_config('request.jwt.claim.sub', $1, true)", [actor]);
}
async function owner() { await q("RESET ROLE"); }

describe("real Postgres: migrations, authentication guard, RLS and audited access", () => {
  beforeAll(async () => {
    cx = await db.reserve();
    await q("BEGIN");
    await q('CREATE SCHEMA "' + schema + '"');
    await q('SET LOCAL search_path TO "' + schema + '", public');
    const files = readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      const ddl = readFileSync("drizzle/" + file, "utf8")
        .replaceAll('"public".', '"' + schema + '".')
        .replaceAll("public.", schema + ".")
        .replaceAll("hms_private", privateSchema)
        .replaceAll("hms_auth_user_created", "hms_auth_" + suffix);
      for (const statement of ddl.split("--> statement-breakpoint")) {
        if (statement.trim()) await q(statement);
      }
    }
    await q('GRANT USAGE ON SCHEMA "' + schema + '" TO anon, authenticated');
    for (const [name, actor] of Object.entries(actors)) {
      await q("insert into auth.users (id,email,raw_user_meta_data,raw_app_meta_data,aud,role,created_at,updated_at) values ($1,$2,jsonb_build_object('name',$3::text,'dob','1990-01-01'),'{}'::jsonb,'authenticated','authenticated',now(),now())",
        [actor,"hms-fixture-" + actor + "@example.invalid",name]);
      const [p] = await q("select id from " + t("profiles") + " where auth_user_id=$1", [actor]);
      subjects[name] = p.id;
    }
    await q("update " + t("profiles") + " set role='doctor' where id=$1",[subjects.doctor]);
    await q("insert into " + t("doctors") + " (id,registration_number,registering_council,specialities,languages,bio,consult_fee_inr,consult_fee_usd,verified_at) values ($1,'TEST-REG','Test council',array['General medicine'],array['English'],'Sample doctor',500,10,now())",[subjects.doctor]);
    await q("insert into " + t("data_sources") + "(id,user_id,provider) values ($1,$2,'generic_csv')",[source,subjects.alice]);
    await q("insert into " + t("metrics") + "(user_id,source_id,metric_type,value,unit,recorded_at) values ($1,$2,'heart_rate',70,'bpm',now())",[subjects.alice,source]);
    await q("insert into " + t("daily_summaries") + "(user_id,day,rhr) values ($1,current_date,60)",[subjects.alice]);
    await q("insert into " + t("consents") + "(user_id,granted_by,authority,consent_type,policy_version,ip_hash) values ($1,$2,'self','doctor_sharing','test',$3)",[subjects.alice,actors.alice,hash]);
    await q("insert into " + t("doctor_patient_links") + "(doctor_id,patient_id,status,granted_scopes) values ($1,$2,'active',array['summary_only']::" + t("sharing_scope") + "[])",[subjects.doctor,subjects.alice]);
  });
  beforeEach(async () => { await q("SAVEPOINT hms_case"); });
  afterEach(async () => { await q("ROLLBACK TO SAVEPOINT hms_case"); await q("RELEASE SAVEPOINT hms_case"); });
  afterAll(async () => {
    if (cx) { await q("ROLLBACK"); cx.release(); }
    await db.end();
  });
  it("migrates all 21 required/supporting tables from scratch with RLS", async () => {
    const tables=await q("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind='r'",[schema]);
    expect(tables).toHaveLength(21);
    expect(tables.every(t => t.relrowsecurity)).toBe(true);
  });
  it("permits A to see their metric but B cannot read A's data", async () => {
    await actAs(actors.alice);
    expect(await q("select * from " + t("metrics"))).toHaveLength(1);
    await actAs(actors.bob);
    expect(await q("select * from " + t("metrics"))).toHaveLength(0);
  });
  it("denies anonymous reads", async () => {
    await q("SET LOCAL ROLE anon");
    await expect(q("select * from " + t("metrics"))).rejects.toMatchObject({code:"42501"});
  });
  it("prevents role/ownership elevation through direct updates", async () => {
    await actAs(actors.alice);
    await expect(q("update " + t("profiles") + " set role='admin' where id=$1",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("rejects direct Auth account creation for a minor", async () => {
    await expect(q("insert into auth.users(id,raw_user_meta_data) values ($1,jsonb_build_object('dob','2015-01-01'))",[randomUUID()])).rejects.toMatchObject({code:"23514"});
  });
  it("rejects direct Auth account creation without DOB", async () => {
    await expect(q("insert into auth.users(id,raw_user_meta_data) values ($1,'{}'::jsonb)",[randomUUID()])).rejects.toMatchObject({code:"23514"});
  });
  it("ignores user-controlled role metadata", async () => {
    const actor=randomUUID();
    await q("insert into auth.users(id,raw_user_meta_data) values ($1,jsonb_build_object('dob','1990-01-01','role','admin'))",[actor]);
    const [p]=await q("select role from " + t("profiles") + " where auth_user_id=$1",[actor]);
    expect(p.role).toBe("patient");
  });
  it("creates a dependent without a login, with guardian consent and non-revocable full scope", async () => {
    await actAs(actors.guardian);
    const [created]=await q("select " + fn("create_dependent") + "('Sample dependent','2015-01-01','test',$1) as id",[hash]);
    const subject=created.id as string;
    expect(await q("select * from " + t("profiles") + " where id=$1",[subject])).toHaveLength(0);
    await q("select " + fn("read_patient") + "($1,'summary_only')",[subject]);
    await owner();
    const [p]=await q("select * from " + t("profiles") + " where id=$1",[subject]);
    expect(p.auth_user_id).toBeNull();
    expect(p.owner_account_id).toBe(actors.guardian);
    const [c]=await q("select * from " + t("consents") + " where user_id=$1",[subject]);
    expect(c.authority).toBe("guardian");
    expect(c.granted_by).toBe(actors.guardian);
    const [l]=await q("select to_jsonb(granted_scopes) as granted_scopes from " + t("caregiver_links") + " where patient_id=$1",[subject]);
    expect(l.granted_scopes).toEqual(["summary_only","full_history","alerts"]);
    expect(await q("select * from " + t("audit_log") + " where target_user_id=$1 and action='guardian_read'",[subject])).toHaveLength(1);
    await actAs(actors.bob);
    expect(await q("select * from " + t("profiles") + " where id=$1",[subject])).toHaveLength(0);
    await expect(q("update " + t("caregiver_links") + " set status='revoked' where patient_id=$1",[subject])).rejects.toMatchObject({code:"42501"});
  });
  it("enforces the guardian invariant at the database level", async () => {
    await actAs(actors.guardian);
    const [p]=await q("select " + fn("create_dependent") + "('Sample dependent','2015-01-01','test',$1) as id",[hash]);
    await owner();
    await q("update " + t("caregiver_links") + " set status='revoked' where patient_id=$1",[p.id]);
    await expect(q("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({code:"23514"});
  });
  it("gives a summary-only doctor a summary, no raw History, and writes an audit row per read", async () => {
    await actAs(actors.doctor);
    expect(await q("select * from " + t("metrics"))).toHaveLength(0);
    for (let i=0;i<2;i++) {
      const [row]=await q("select " + fn("read_patient") + "($1,'summary_only') as body",[subjects.alice]);
      expect(row.body.daily_summaries).toHaveLength(1);
      expect(row.body).not.toHaveProperty("metrics");
    }
    await owner();
    expect(await q("select * from " + t("audit_log") + " where actor_id=$1 and target_user_id=$2",[actors.doctor,subjects.alice])).toHaveLength(2);
    await actAs(actors.doctor);
    await expect(q("select " + fn("read_patient") + "($1,'full_history')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("removes sharing immediately when consent is revoked", async () => {
    await q("update " + t("consents") + " set revoked_at=now() where user_id=$1",[subjects.alice]);
    await actAs(actors.doctor);
    await expect(q("select " + fn("read_patient") + "($1,'summary_only')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("rejects a pending/unverified doctor's access", async () => {
    await q("update " + t("doctors") + " set verified_at=null where id=$1",[subjects.doctor]);
    await actAs(actors.doctor);
    await expect(q("select " + fn("read_patient") + "($1,'summary_only')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("rejects a metric whose source belongs to a different profile", async () => {
    await expect(q("insert into " + t("metrics") + "(user_id,source_id,metric_type,value,unit,recorded_at) values ($1,$2,'heart_rate',70,'bpm',now())",[subjects.bob,source])).rejects.toMatchObject({code:"23503"});
  });
  it("prevents clients from rewriting or deleting audit records", async () => {
    await actAs(actors.alice);
    await expect(q("delete from " + t("audit_log") + " where target_user_id=$1",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });

  async function connect(subject = subjects.alice) {
    await q("select " + fn("record_consent") + "($1,'data_ingestion',true,'test',$2)",[subject,hash]);
    const [row] = await q("select " + fn("connect_source") + "($1,'apple_health_export','Apple Health') as id",[subject]);
    return row.id as string;
  }
  const batch = normaliseApple({ type: "HKQuantityTypeIdentifierHeartRate", value: "70", unit: "count/min", startDate: "2026-08-08 23:00:00 +0530", endDate: "2026-08-09 01:00:00 +0530", sourceName: "Sample watch" });
  const ingest = (subject: string, sourceId: string, data: unknown = batch) => q("select " + fn("ingest_batch") + "($1,$2,$3::text::jsonb) as result", [subject, sourceId, JSON.stringify(data)]);
  it("persists bounded metrics, keeps source IDs stable and deduplicates re-imports", async () => {
    await actAs(actors.alice);
    const id = await connect();
    const [again] = await q("select " + fn("connect_source") + "($1,'apple_health_export','Apple Health') as id",[subjects.alice]);
    expect(again.id).toBe(id);
    expect((await ingest(subjects.alice,id))[0].result).toEqual({ inserted: 1, skipped: 0 });
    expect((await ingest(subjects.alice,id))[0].result).toEqual({ inserted: 0, skipped: 1 });
    expect((await ingest(subjects.alice,id,[{ ...batch[0], device: "Second sample watch" }]))[0].result.inserted).toBe(1);
    await owner();
    const jobs = await q("select day::text,revision from " + t("summary_jobs") + " where user_id=$1 order by day", [subjects.alice]);
    expect(jobs.map(j => j.day)).toEqual(["2026-08-08", "2026-08-09"]);
    expect(jobs.every(j => j.revision === 2)).toBe(true);
    // Adapters only queue work; the existing summary is unchanged until M3.
    expect((await q("select * from " + t("daily_summaries") + " where user_id=$1", [subjects.alice]))).toHaveLength(1);
  });
  it("requires ingestion consent even for the profile owner", async () => {
    await actAs(actors.alice);
    await expect(q("select " + fn("connect_source") + "($1,'generic_csv','CSV')",[subjects.alice])).rejects.toMatchObject({ code: "42501" });
  });
  it("stops later batches as soon as ingestion consent is withdrawn", async () => {
    await actAs(actors.alice); const id = await connect();
    await q("select " + fn("record_consent") + "($1,'data_ingestion',false,'test',$2)",[subjects.alice,hash]);
    await expect(ingest(subjects.alice,id)).rejects.toMatchObject({ code: "42501" });
  });
  it("rejects another account's source even with consent on the target profile", async () => {
    await actAs(actors.bob); await connect(subjects.bob);
    await expect(ingest(subjects.bob,source)).rejects.toMatchObject({ code: "42501" });
  });
  it("lets a guardian import only into their dependent and audits the operation", async () => {
    await actAs(actors.guardian);
    const [p] = await q("select " + fn("create_dependent") + "('Sample child','2015-01-01','test',$1) as id",[hash]);
    const id = await connect(p.id);
    expect((await ingest(p.id,id))[0].result.inserted).toBe(1);
    expect(await q("select * from " + t("metrics") + " where user_id=$1",[p.id])).toHaveLength(0);
    await owner();
    expect(await q("select * from " + t("audit_log") + " where target_user_id=$1 and action='guardian_ingest'",[p.id])).toHaveLength(1);
    await actAs(actors.bob);
    await expect(ingest(p.id,id)).rejects.toMatchObject({ code: "42501" });
  });
  it.each([
    ["too many records", Array(1001).fill(batch[0])],
    ["wrong units", [{ ...batch[0], unit: "kg" }]],
    ["non-numeric value", [{ ...batch[0], value: "NaN" }]],
    ["fractional duration", [{ ...batch[0], duration_s: 2.5 }]],
    ["huge device name", [{ ...batch[0], device: "x".repeat(300) }]],
    ["future timestamp", [{ ...batch[0], recorded_at: "2099-01-01T00:00:00Z" }]],
    ["unfinished measurement interval", [{ ...batch[0], recorded_at: new Date(Date.now() - 3600000).toISOString(), duration_s: 7200 }]],
  ])("rejects %s at the database boundary, bypassing the Next API", async (_name, invalid) => {
    await actAs(actors.alice); const id = await connect();
    await expect(ingest(subjects.alice,id,invalid)).rejects.toMatchObject({ code: "22023" });
  });
  it("does not expose the job queue directly to authenticated users", async () => {
    await actAs(actors.alice);
    await expect(q("select * from " + t("summary_jobs"))).rejects.toMatchObject({ code: "42501" });
  });

  function summaryStore() {
    return new PostgresSummaryStore(cx, { schema, transaction: async work => {
      const point = "job_" + randomUUID().replaceAll("-", "");
      await q("SAVEPOINT " + point);
      try { const result = await work(cx); await q("RELEASE SAVEPOINT " + point); return result; }
      catch (error) { await q("ROLLBACK TO SAVEPOINT " + point); await q("RELEASE SAVEPOINT " + point); throw error; }
    } });
  }
  const analyticsMetric = (day: number, metric_type: string, value: number, unit: string, hour = "06") => ({ metric_type, value, unit,
    recorded_at: "2026-06-" + String(day).padStart(2, "0") + "T" + hour + ":00:00Z", duration_s: null, quality: "raw", external_id: null });
  it("processes durable jobs into summaries/baselines and propagates historical corrections", async () => {
    await q("delete from " + t("daily_summaries") + " where user_id=$1", [subjects.alice]);
    await actAs(actors.alice); const id = await connect();
    const data = Array.from({ length: 8 }, (_, i) => [analyticsMetric(i + 1, "resting_heart_rate", i === 7 ? 72 : 60, "bpm"), analyticsMetric(i + 1, "hrv_rmssd", 50, "ms"), analyticsMetric(i + 1, "sleep_duration", 480, "min"), analyticsMetric(i + 1, "skin_temperature", i === 7 ? 34.7 : 33.4, "°C")]).flat();
    expect((await ingest(subjects.alice, id, data))[0].result.inserted).toBe(32);
    await owner(); const store = summaryStore();
    const firstJob = await store.claim(new Date());
    expect(firstJob).not.toBeNull();
    expect(await store.process(firstJob!, new Date())).toBe(7);
    const result = await runSummaryJobs(store, { limit: 20, timeBudgetMs: 50000 });
    expect(result).toEqual({ completed: 1, failed: 0, stale: 0, withheld: 0 });
    let summaries = await q("select day::text,rhr::float,recovery_score::float,skin_temp_deviation::float from " + t("daily_summaries") + " where user_id=$1 order by day", [subjects.alice]);
    expect(summaries).toHaveLength(8); expect(summaries[0].recovery_score).toBeNull(); expect(summaries[7].recovery_score).toBe(67);
    expect(summaries[7].skin_temp_deviation).toBeCloseTo(1.3);
    const [baseline] = await q("select median::float,sample_count from " + t("baselines") + " where user_id=$1 and metric_type='resting_heart_rate'", [subjects.alice]);
    expect(baseline).toMatchObject({ median: 60, sample_count: 7 });
    expect(await q("select * from " + t("audit_log") + " where target_user_id=$1 and action='system_summary_read'", [subjects.alice])).toHaveLength(8);
    await actAs(actors.alice);
    const historical = Array.from({ length: 7 }, (_, i) => analyticsMetric(i + 1, "resting_heart_rate", 120, "bpm", "08"));
    expect((await ingest(subjects.alice, id, historical))[0].result.inserted).toBe(7);
    await owner(); expect((await runSummaryJobs(store, { limit: 20, timeBudgetMs: 50000 })).completed).toBe(7);
    summaries = await q("select day::text,recovery_score::float from " + t("daily_summaries") + " where user_id=$1 order by day", [subjects.alice]);
    expect(summaries[7].recovery_score).toBe(100);
    expect(await q("select * from " + t("summary_jobs") + " where user_id=$1 and revision>processed_revision", [subjects.alice])).toHaveLength(0);
  }, 60000);
  it("fences stale workers, withholds revoked-consent work and retries failures durably", async () => {
    await actAs(actors.alice); const id = await connect();
    await ingest(subjects.alice, id, [analyticsMetric(1, "resting_heart_rate", 60, "bpm")]);
    await owner(); const store = summaryStore(); const clock = new Date(Date.now() + 1000);
    const first = (await store.claim(clock))!;
    expect(await store.claim(clock)).toBeNull();
    const reclaimed = (await store.claim(new Date(clock.getTime() + 121000)))!;
    expect(reclaimed.id).toBe(first.id); expect(reclaimed.token).not.toBe(first.token);
    expect(await store.process(first, clock)).toBe("stale");
    await q("update " + t("profiles") + " set timezone='Invalid/Timezone' where id=$1", [subjects.alice]);
    await expect(store.process(reclaimed, clock)).rejects.toThrow();
    await store.retry(reclaimed, clock, "RangeError");
    expect(await store.claim(clock)).toBeNull();
    const [state] = await q("select last_error,lease_token from " + t("summary_jobs") + " where id=$1", [reclaimed.id]);
    expect(state).toMatchObject({ last_error: "RangeError", lease_token: null });
    await q("update " + t("profiles") + " set timezone='UTC' where id=$1", [subjects.alice]);
    const retry = (await store.claim(new Date(clock.getTime() + 241000)))!;
    await q("update " + t("consents") + " set revoked_at=now() where user_id=$1 and consent_type='data_ingestion'", [subjects.alice]);
    expect(await store.process(retry, clock)).toBe("withheld");
    expect(await store.claim(new Date(clock.getTime() + 500000))).toBeNull();
    expect(await q("select * from " + t("summary_jobs") + " where id=$1 and revision>processed_revision", [retry.id])).toHaveLength(1);
  });

  function deliveryStore() {
    return new PostgresDeliveryStore(cx, { schema, transaction: async work => {
      const point = "delivery_" + randomUUID().replaceAll("-", "");
      await q("SAVEPOINT " + point);
      try { const result = await work(cx); await q("RELEASE SAVEPOINT " + point); return result; }
      catch (error) { await q("ROLLBACK TO SAVEPOINT " + point); await q("RELEASE SAVEPOINT " + point); throw error; }
    } });
  }
  async function urgentFixture() {
    const now = new Date(Date.now() + 1000);
    await q("update " + t("profiles") + " set timezone='UTC' where id=$1", [subjects.alice]);
    await actAs(actors.alice); const id = await connect();
    const rows = Array.from({ length: 35 }, (_, minute) => ({ metric_type: "spo2", value: minute < 12 ? 88 : 91, unit: "%", recorded_at: new Date(now.getTime() - 3600000 + minute * 60000).toISOString(), duration_s: 60, quality: "raw", external_id: null }));
    await ingest(subjects.alice, id, rows); await owner();
    const result = await runSummaryJobs(summaryStore(), { limit: 3, clock: () => now });
    expect(result.failed).toBe(0);
    const alerts = await q("select * from " + t("alerts") + " where user_id=$1 order by severity", [subjects.alice]);
    expect(alerts).toHaveLength(2);
    const urgent = alerts.find(a => a.severity === "urgent")!;
    // This fixture tests escalation only; patient email is covered separately.
    await q("delete from " + t("alert_deliveries") + " where user_id=$1", [subjects.alice]);
    await q("update " + t("profiles") + " set emergency_contact=$2::text::jsonb where id=$1", [subjects.alice, JSON.stringify({ name: "Sample contact", email: "hms-contact@example.invalid" })]);
    await actAs(actors.alice);
    await q("select " + fn("record_consent") + "($1,'emergency_contact',true,'test',$2)", [subjects.alice, hash]);
    await owner();
    return { now, urgent };
  }
  it("persists all recommended defaults exactly and accepts explicit resting context", async () => {
    const rules = await q("select * from " + t("alert_rules") + " where user_id is null order by id");
    expect(rules.map(r => [r.id,r.rule_key,r.metric_type,r.comparator,r.threshold_type,Number(r.value),r.min_duration_s,r.severity,r.enabled])).toEqual(defaultRules.map(r => [r.id,r.rule_key,r.metric_type,r.comparator,r.threshold_type,r.value,r.min_duration_s,r.severity,r.enabled]));
    await actAs(actors.alice); const id = await connect();
    await ingest(subjects.alice, id, [{ ...analyticsMetric(1, "heart_rate", 160, "bpm"), at_rest: true, duration_s: 300 }]);
    const [row] = await q("select at_rest from " + t("metrics") + " where user_id=$1 and value=160", [subjects.alice]);
    expect(row.at_rest).toBe(true);
  });
  it("keeps repeated computations idempotent and the 15-minute deadline persisted", async () => {
    const { now, urgent } = await urgentFixture();
    expect(new Date(urgent.escalation_due_at).getTime()).toBe(now.getTime() + 900000);
    expect(urgent.metric_snapshot.body).toMatch(/^Unusual reading: SpO2 was 88 % at /);
    expect(urgent.metric_snapshot.body).toContain("That's outside your normal range. If you feel unwell, call 112 or contact your doctor.");
    await q("update " + t("summary_jobs") + " set revision=revision+1 where user_id=$1", [subjects.alice]);
    expect((await runSummaryJobs(summaryStore(), { limit: 3, clock: () => now })).failed).toBe(0);
    expect(await q("select * from " + t("alerts") + " where user_id=$1", [subjects.alice])).toHaveLength(2);
    const store = deliveryStore();
    expect(await store.escalate(new Date(now.getTime() + 899999))).toBe(0);
    expect(await store.escalate(new Date(now.getTime() + 900000))).toBe(1);
    expect(await deliveryStore().escalate(new Date(now.getTime() + 900000))).toBe(0);
    expect(await q("select * from " + t("alert_deliveries") + " where recipient_kind='contact'")).toHaveLength(1);
  });
  it("withholds an escalation when acknowledgement arrives after the claim", async () => {
    const { now, urgent } = await urgentFixture(), clock = new Date(now.getTime() + 900000);
    const store = deliveryStore(); await store.escalate(clock);
    const job = (await store.claim(clock))!; expect(job).not.toBeNull();
    expect(await deliveryStore().claim(clock)).toBeNull();
    await actAs(actors.alice);
    await q("select " + fn("alert_settings") + "($1,'acknowledge',$2::text::jsonb)", [subjects.alice, JSON.stringify({ alertId: urgent.id })]);
    await owner(); expect(await store.prepare(job, clock)).toBeNull();
    expect((await q("select status from " + t("alert_deliveries") + " where id=$1", [job.id]))[0].status).toBe("cancelled");
  });
  it("rechecks consent withdrawal after claim and does not deliver", async () => {
    const { now } = await urgentFixture(), clock = new Date(now.getTime() + 900000);
    const store = deliveryStore(); await store.escalate(clock); const job = (await store.claim(clock))!;
    await actAs(actors.alice); await q("select " + fn("record_consent") + "($1,'emergency_contact',false,'test',$2)", [subjects.alice, hash]); await owner();
    expect(await store.prepare(job, clock)).toBeNull();
    expect(await store.claim(new Date(clock.getTime() + 500000))).toBeNull();
  });
  it("retries failures, fences old leases and prevents overlapping sends", async () => {
    const { now, urgent } = await urgentFixture(); let clock = new Date(now.getTime() + 900000);
    const store = deliveryStore(); await store.escalate(clock); const first = (await store.claim(clock))!;
    clock = new Date(clock.getTime() + 121000);
    const reclaimed = (await deliveryStore().claim(clock))!;
    expect(reclaimed.token).not.toBe(first.token); expect(await store.prepare(first, clock)).toBeNull();
    const payload = await store.prepare(reclaimed, clock); expect(payload?.to).toBe("hms-contact@example.invalid");
    await store.retry(reclaimed, clock, "EmailHTTP503"); expect(await store.claim(clock)).toBeNull();
    clock = new Date(clock.getTime() + 121000);
    let sends = 0;
    const transport = { async send() {
      sends++;
      // A second invocation starts while the first provider call is in flight.
      const overlap = await dispatchAlerts(deliveryStore(), { async send() { throw new Error("DuplicateSend"); } }, { clock: () => clock });
      expect(overlap.sent + overlap.stubbed + overlap.failed).toBe(0);
      return "stubbed" as const;
    } };
    const result = await dispatchAlerts(store, transport, { clock: () => clock });
    expect(result.stubbed).toBe(1); expect(sends).toBe(1);
    expect((await dispatchAlerts(store, transport, { clock: () => clock })).stubbed).toBe(0);
    expect((await q("select escalated_to_contact_at from " + t("alerts") + " where id=$1", [urgent.id]))[0].escalated_to_contact_at).toBeNull();
  });
  it("keeps old imported alerts in history without sending or escalating", async () => {
    await actAs(actors.alice); const id = await connect();
    await ingest(subjects.alice, id, [{ ...analyticsMetric(1, "blood_pressure_systolic", 181, "mmHg"), quality: "user_entered" }]);
    await owner(); expect((await runSummaryJobs(summaryStore(), { limit: 3 })).failed).toBe(0);
    const [alert] = await q("select is_historical,escalation_due_at from " + t("alerts") + " where user_id=$1", [subjects.alice]);
    expect(alert).toMatchObject({ is_historical: true, escalation_due_at: null });
    expect(await q("select * from " + t("alert_deliveries"))).toHaveLength(0);
  });
  it("does not expose delivery payloads or permit another user to acknowledge", async () => {
    const { urgent } = await urgentFixture(); await actAs(actors.bob);
    await expect(q("select " + fn("alert_settings") + "($1,'acknowledge',$2::text::jsonb)", [subjects.alice, JSON.stringify({ alertId: urgent.id })])).rejects.toMatchObject({ code: "42501" });
  });
  it("hides the outbox from authenticated Data API callers", async () => {
    await actAs(actors.alice); await expect(q("select * from " + t("alert_deliveries"))).rejects.toMatchObject({ code: "42501" });
  });
  it("cancels contact delivery after the provider idempotency window without sending again", async () => {
    const { now } = await urgentFixture(), clock = new Date(now.getTime() + 900000);
    const store = deliveryStore(); await store.escalate(clock); await store.claim(clock);
    const later = new Date(clock.getTime() + 23 * 3600000), job = (await store.claim(later))!;
    expect(await store.prepare(job, later)).toBeNull();
    expect((await q("select status,last_error from " + t("alert_deliveries") + " where id=$1", [job.id]))[0]).toMatchObject({ status: "failed", last_error: "IdempotencyWindowExpired" });
  });
  it("forwards only to consented caregivers and rechecks link revocation", async () => {
    const { now, urgent } = await urgentFixture();
    await q("update auth.users set email_confirmed_at=now() where id=$1", [actors.bob]);
    await q("insert into " + t("caregiver_links") + "(patient_id,caregiver_id,role,status,granted_scopes,invited_by) values($1,$2,'caregiver','active',array['summary_only','alerts']::" + t("sharing_scope") + "[],'patient')", [subjects.alice, actors.bob]);
    await actAs(actors.bob); await q("select " + fn("record_consent") + "($1,'alert_email',true,'test',$2)", [subjects.bob, hash]); await owner();
    await q("insert into " + t("alert_deliveries") + "(user_id,alert_id,recipient_kind,recipient_key,available_at) values($1,$2,'caregiver',$3,$4)", [subjects.alice, urgent.id, actors.bob, now.toISOString()]);
    const store = deliveryStore(), job = (await store.claim(now))!;
    expect((await store.prepare(job, now))?.to).toContain(actors.bob);
    await q("update " + t("caregiver_links") + " set status='revoked',revoked_at=now() where patient_id=$1 and caregiver_id=$2", [subjects.alice, actors.bob]);
    expect(await store.prepare(job, now)).toBeNull();
    expect(await q("select * from " + t("audit_log") + " where action='system_notification_read' and metadata->>'recipient_actor'=$1", [actors.bob])).toHaveLength(1);
  });
  it("allows owner threshold overrides and clears consent when the contact changes", async () => {
    await actAs(actors.alice);
    await q("select " + fn("alert_settings") + "($1,'rule',$2::text::jsonb)", [subjects.alice, JSON.stringify({ key: "spo2-urgent", value: 89, duration: 900, enabled: false })]);
    const [read] = await q("select " + fn("alert_settings") + "($1,'read') as settings", [subjects.alice]);
    expect(read.settings.rules.find((r: { rule_key: string }) => r.rule_key === "spo2-urgent")).toMatchObject({ value: 89, min_duration_s: 900, enabled: false });
    await q("select " + fn("record_consent") + "($1,'emergency_contact',true,'test',$2)", [subjects.alice, hash]);
    await q("select " + fn("alert_settings") + "($1,'contact',$2::text::jsonb)", [subjects.alice, JSON.stringify({ name: "Sample", email: "other@example.invalid" })]);
    const [changed] = await q("select " + fn("alert_settings") + "($1,'read') as settings", [subjects.alice]);
    expect(changed.settings.consents).not.toContain("emergency_contact");
  });
});
