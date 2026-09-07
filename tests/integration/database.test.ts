import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  it("migrates all 19 required/supporting tables from scratch with RLS", async () => {
    const tables=await q("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind='r'",[schema]);
    expect(tables).toHaveLength(19);
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
});
