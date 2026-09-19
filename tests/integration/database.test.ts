import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normaliseApple } from "../../src/lib/ingestion/apple-normalise";
import { normaliseGoogle } from "../../src/lib/integrations/normalise";
import { PostgresSummaryStore } from "../../src/lib/jobs/summary-store";
import { runSummaryJobs } from "../../src/lib/jobs/summary-runner";
import { PostgresDeliveryStore } from "../../src/lib/alerts/delivery-store";
import { dispatchAlerts } from "../../src/lib/alerts/dispatch";
import { defaultRules } from "../../src/lib/alerts/rules";
import { advanceSyncVisit, fairSyncCheckpoint, syncCheckpoint } from "../../src/lib/integrations/checkpoint";

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
const q = (query: string, values: (string | number | boolean | null)[] = []) => cx.unsafe(query, values);
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
        .replaceAll("hms_documents_routes_only", "hms_documents_" + suffix)
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
  it("migrates all 24 required/supporting tables from scratch with RLS", async () => {
    const tables=await q("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind='r'",[schema]);
    expect(tables).toHaveLength(24);
    expect(tables.every(t => t.relrowsecurity)).toBe(true);
  });
  it.each(["anon", "authenticated"])("keeps private wearable checkpoints inaccessible to %s", async role => {
    const [column] = await q("select data_type from information_schema.columns where table_schema=$1 and table_name='integration_connections' and column_name='sync_checkpoint'", [privateSchema]);
    expect(column.data_type).toBe("jsonb");
    await q("SET LOCAL ROLE " + role);
    await expect(q('select sync_checkpoint from "' + privateSchema + '".integration_connections')).rejects.toMatchObject({ code: "42501" });
  });
  it("rejects stale checkpoint writes after cursor advancement, token replacement or disconnect", async () => {
    const wearableSource = randomUUID();
    await q("insert into " + t("data_sources") + "(id,user_id,provider) values($1,$2,'whoop_api')", [wearableSource, subjects.alice]);
    await q('insert into "' + privateSchema + '".integration_connections(user_id,provider,source_id,external_account_id,encrypted_tokens) values($1,\'whoop\',$2,\'fixture\',\'version-1\')', [subjects.alice, wearableSource]);
    const cursor = JSON.stringify({ version: 1, nextToken: "page-2" });
    const next = JSON.stringify({ version: 1, nextToken: "page-3" });
    const compareAndSwap = (version: string, expected: string | null, value: string) => q('update "' + privateSchema + '".integration_connections c set sync_checkpoint=$1::text::jsonb from ' + t("data_sources") + " s where c.user_id=$2 and c.provider='whoop' and c.encrypted_tokens=$3 and c.sync_checkpoint is not distinct from $4::text::jsonb and s.id=c.source_id and s.user_id=c.user_id and s.status='connected' returning c.user_id", [value, subjects.alice, version, expected]);
    expect(await compareAndSwap("version-1", null, cursor)).toHaveLength(1);
    expect(await compareAndSwap("version-1", null, next)).toHaveLength(0);
    await q('update "' + privateSchema + '".integration_connections set encrypted_tokens=\'version-2\' where user_id=$1', [subjects.alice]);
    expect(await compareAndSwap("version-1", cursor, next)).toHaveLength(0);
    await q("update " + t("data_sources") + " set status='disconnected' where id=$1", [wearableSource]);
    expect(await compareAndSwap("version-2", cursor, next)).toHaveLength(0);
    const [row] = await q('select sync_checkpoint from "' + privateSchema + '".integration_connections where user_id=$1', [subjects.alice]);
    expect(row.sync_checkpoint).toEqual(JSON.parse(cursor));
  });
  it("CAS-upgrades a legacy checkpoint and persists independent v2 metric cursors", async () => {
    const wearableSource = randomUUID();
    await q("insert into " + t("data_sources") + "(id,user_id,provider) values($1,$2,'whoop_api')", [wearableSource, subjects.alice]);
    const legacy = syncCheckpoint.parse({ version: 1, provider: "whoop", window: { start: "2026-09-11T10:00:00.000Z", end: "2026-09-18T10:00:00.000Z", firstDay: "2026-09-11", nextDay: "2026-09-19" }, collections: ["sleep", "recovery", "cycle"], collectionIndex: 1, nextToken: "recovery-page-2" });
    await q('insert into "' + privateSchema + '".integration_connections(user_id,provider,source_id,external_account_id,encrypted_tokens,sync_checkpoint) values($1,\'whoop\',$2,\'fixture\',\'version-1\',$3::text::jsonb)', [subjects.alice, wearableSource, JSON.stringify(legacy)]);
    const upgraded = fairSyncCheckpoint(legacy);
    const compareAndSwap = (expected: unknown, next: unknown) => q('update "' + privateSchema + '".integration_connections c set sync_checkpoint=$1::text::jsonb from ' + t("data_sources") + " s where c.user_id=$2 and c.provider='whoop' and c.encrypted_tokens='version-1' and c.sync_checkpoint is not distinct from $3::text::jsonb and s.id=c.source_id and s.user_id=c.user_id and s.status='connected' returning c.sync_checkpoint", [JSON.stringify(next), subjects.alice, JSON.stringify(expected)]);
    const [first] = await compareAndSwap(legacy, upgraded);
    expect(first.sync_checkpoint).toEqual(upgraded);
    expect(await compareAndSwap(legacy, upgraded)).toHaveLength(0);
    const next = advanceSyncVisit(upgraded, { lane: "reconciliation", index: 1 }, "recovery-page-3");
    const [stored] = await compareAndSwap(upgraded, next);
    expect(stored.sync_checkpoint).toEqual(next);
    expect(stored.sync_checkpoint.cursors).toEqual([{ complete: true, nextToken: "" }, { complete: false, nextToken: "recovery-page-3" }, { complete: false, nextToken: "" }]);
    expect(stored.sync_checkpoint.reconciliationIndex).toBe(2);
  });
  it("preserves an active provider cooldown through completion and ignores a replaced grant", async () => {
    const wearableSource = randomUUID();
    await q("insert into " + t("data_sources") + "(id,user_id,provider) values($1,$2,'whoop_api')", [wearableSource, subjects.alice]);
    const checkpoint = fairSyncCheckpoint(syncCheckpoint.parse({ version: 1, provider: "whoop", window: { start: "2026-09-11T10:00:00.000Z", end: "2026-09-18T10:00:00.000Z", firstDay: "2026-09-11", nextDay: "2026-09-19" }, collections: ["sleep"], collectionIndex: 1, nextToken: "" }));
    await q('insert into "' + privateSchema + '".integration_connections(user_id,provider,source_id,external_account_id,encrypted_tokens,sync_checkpoint,next_sync_at,last_error) values($1,\'whoop\',$2,\'fixture\',\'version-1\',$3::text::jsonb,now()+interval \'2 hours\',\'ProviderRateLimited\')', [subjects.alice, wearableSource, JSON.stringify(checkpoint)]);
    // The production store locks and checks the grant before issuing this update.
    // Exercise its timestamp/old-row CASE semantics against real Postgres.
    const [before] = await q('select next_sync_at::text from "' + privateSchema + '".integration_connections where user_id=$1', [subjects.alice]);
    const [completed] = await q('update "' + privateSchema + '".integration_connections c set next_sync_at=greatest(next_sync_at,now()+interval \'1 minute\'),sync_locked_until=null,sync_checkpoint=null,last_error=case when last_error=\'ProviderRateLimited\' and next_sync_at>now() then last_error else null end where c.user_id=$1 and c.sync_checkpoint is not distinct from $2::text::jsonb returning next_sync_at::text,last_error,sync_checkpoint', [subjects.alice, JSON.stringify(checkpoint)]);
    expect(completed).toEqual({ next_sync_at: before.next_sync_at, last_error: "ProviderRateLimited", sync_checkpoint: null });
    await q('update "' + privateSchema + '".integration_connections set encrypted_tokens=\'version-2\' where user_id=$1', [subjects.alice]);
    expect(await q('select c.last_error,c.next_sync_at::text from "' + privateSchema + '".integration_connections c join ' + t("data_sources") + " s on s.id=c.source_id where c.user_id=$1 and c.encrypted_tokens='version-1' and s.status='connected' and c.provider='whoop' for update of c", [subjects.alice])).toHaveLength(0);
    await q('update "' + privateSchema + '".integration_connections set next_sync_at=now()-interval \'1 minute\',sync_checkpoint=$2::text::jsonb where user_id=$1', [subjects.alice, JSON.stringify(checkpoint)]);
    const [expired] = await q('update "' + privateSchema + '".integration_connections set next_sync_at=greatest(next_sync_at,now()+interval \'1 minute\'),last_error=case when last_error=\'ProviderRateLimited\' and next_sync_at>now() then last_error else null end where user_id=$1 returning last_error,next_sync_at>now() scheduled', [subjects.alice]);
    expect(expired).toEqual({ last_error: null, scheduled: true });
  });
  it("roundtrips serialised provider metadata and normalised metric pages as JSON objects", async () => {
    await actAs(actors.alice);
    await q("select " + fn("record_consent") + "($1,'data_ingestion',true,'test',$2)", [subjects.alice, hash]);
    await owner();
    const wearableSource = randomUUID();
    const metadata = { label: "Google Health", connection: "oauth" };
    await q("insert into " + t("data_sources") + "(id,user_id,provider,source_key,metadata) values($1,$2,'google_health_api','root:oauth:google_health',$3::text::jsonb)", [wearableSource, subjects.alice, JSON.stringify(metadata)]);
    const page = normaliseGoogle({ heartRate: { sampleTime: { physicalTime: "2026-09-18T08:00:00Z" }, beatsPerMinute: "72" } }, "heart-rate", "UTC");
    const [result] = await q("select " + fn("ingest_batch") + "($1,$2,$3::text::jsonb) result", [subjects.alice, wearableSource, JSON.stringify(page)]);
    expect(result.result).toEqual({ inserted: 1, skipped: 0 });
    const [stored] = await q("select metadata from " + t("data_sources") + " where id=$1", [wearableSource]);
    expect(stored.metadata).toEqual(metadata);
    const [reading] = await q("select metric_type,value::text from " + t("metrics") + " where source_id=$1", [wearableSource]);
    expect(reading).toEqual({ metric_type: "heart_rate", value: "72" });
  });
  it("permits A to see their metric but B cannot read A's data", async () => {
    await actAs(actors.alice);
    expect(await q("select * from " + t("metrics"))).toHaveLength(1);
    await actAs(actors.bob);
    expect(await q("select * from " + t("metrics"))).toHaveLength(0);
  });
  it("allows anonymous catalogue reads but no catalogue insertion", async () => {
    await q("insert into " + t("device_catalog") + "(brand,model,category,metrics_supported,source_urls,editorial_note) values('Test','Public device','watch',array['heart_rate']::" + t("metric_type") + "[],array['https://example.invalid'],'Synthetic catalogue fixture')");
    await q("SET LOCAL ROLE anon");
    expect(await q("select model from " + t("device_catalog"))).toHaveLength(1);
    await expect(q("insert into " + t("device_catalog") + "(brand,model,category,metrics_supported,source_urls,editorial_note) values('Bad','Untrusted','watch',array['heart_rate']::" + t("metric_type") + "[],array['https://example.invalid'],'Untrusted')")).rejects.toMatchObject({ code: "42501" });
  });
  it("does not let a signed-in patient change reference-device prices", async () => {
    await actAs(actors.alice);
    await expect(q("update " + t("device_catalog") + " set price_inr=0")).rejects.toMatchObject({ code: "42501" });
  });
  async function beginDeletion(actor:string,confirmDependents=false) {
    await actAs(actor);return (await q("select "+fn("begin_account_deletion")+"($1) as d",[confirmDependents]))[0].d;
  }
  async function finishDeletion() {await owner();await q('select "'+privateSchema+'".finish_account_deletion()');}
  it("fences a deleting account and keeps status/retry available without exposing its table",async()=>{
    const d=await beginDeletion(actors.alice);expect(d.profile_ids).toEqual([subjects.alice]);expect(d.stage).toBe("pending");
    expect(await q("select * from "+t("metrics"))).toHaveLength(0);
    const [status]=await q("select "+fn("account_deletion_status")+"() as s");expect(status.s).toEqual({pending:true,stage:"pending",profile_count:1});
    expect((await beginDeletion(actors.alice)).started_at).toBe(d.started_at);
    await expect(q("select * from "+t("account_deletions"))).rejects.toMatchObject({code:"42501"});
  });
  it("requires a separate confirmation when deletion includes owned dependents",async()=>{
    await actAs(actors.guardian);await q("select "+fn("create_dependent")+"('Sample child','2015-01-01','test',$1)",[hash]);
    await expect(beginDeletion(actors.guardian,false)).rejects.toMatchObject({code:"23514"});
  });
  it("keeps mandatory guardianship valid until the dependent is actually purged",async()=>{
    await actAs(actors.guardian);const [child]=await q("select "+fn("create_dependent")+"('Sample child','2015-01-01','test',$1) as id",[hash]);
    const d=await beginDeletion(actors.guardian,true);expect(d.profile_ids).toContain(child.id);await owner();await q("SET CONSTRAINTS ALL IMMEDIATE");
    const [guardian]=await q("select status from "+t("caregiver_links")+" where patient_id=$1 and role='guardian'",[child.id]);expect(guardian.status).toBe("active");
    await actAs(actors.guardian);await expect(q("select "+fn("create_dependent")+"('Another child','2015-01-01','test',$1)",[hash])).rejects.toMatchObject({code:"42501"});
  });
  it("does not expose health-purge authority to authenticated clients",async()=>{
    await beginDeletion(actors.alice);await expect(q('select "'+privateSchema+'".finish_account_deletion()')).rejects.toMatchObject({code:"42501"});
  });
  it("refuses a health purge until the server has finished Storage removal",async()=>{
    await beginDeletion(actors.alice);await expect(finishDeletion()).rejects.toMatchObject({code:"42501"});
  });
  it("purges only owned profiles, anonymises audit rows and keeps a retry fence until Auth deletion",async()=>{
    await q("insert into "+t("audit_log")+"(actor_id,action,target_user_id,target_table,target_id,metadata) values($1,'doctor_read',$2,'metrics',$3,jsonb_build_object('subject',$2::uuid::text))",[actors.doctor,subjects.alice,source]);
    await beginDeletion(actors.alice);await owner();await q("update "+t("account_deletions")+" set stage='storage_removed' where account_id=$1",[actors.alice]);
    await finishDeletion();await finishDeletion();
    expect(await q("select id from "+t("profiles")+" where owner_account_id=$1",[actors.alice])).toHaveLength(0);
    expect(await q("select id from "+t("metrics")+" where user_id=$1",[subjects.alice])).toHaveLength(0);
    expect(await q("select id from "+t("profiles")+" where id=$1",[subjects.bob])).toHaveLength(1);
    const [audit]=await q("select actor_id,target_user_id,target_id,metadata from "+t("audit_log")+" where action='doctor_read'");expect(audit).toEqual({actor_id:null,target_user_id:null,target_id:null,metadata:{}});
    const [intent]=await q("select stage from "+t("account_deletions")+" where account_id=$1",[actors.alice]);expect(intent.stage).toBe("health_removed");
    expect(await q("select id from auth.users where id=$1",[actors.alice])).toHaveLength(1);
    await q("delete from auth.users where id=$1",[actors.alice]);expect(await q("select account_id from "+t("account_deletions")+" where account_id=$1",[actors.alice])).toHaveLength(0);
    await actAs(actors.alice);const [live]=await q('select "'+privateSchema+'".actor_is_live() as live');expect(live.live).toBe(false);
  });
  it("doctor deletion preserves another patient's completed note and Sample data provenance",async()=>{
    await q("update "+t("doctors")+" set is_sample=true where id=$1",[subjects.doctor]);
    const [consult]=await q("insert into "+t("consults")+"(patient_id,doctor_id,type,status,completed_at,doctor_note) values($1,$2,'trend_review','completed',now(),'Sample preserved note') returning id",[subjects.alice,subjects.doctor]);
    await q("insert into "+t("messages")+"(consult_id,sender_id,body) values($1,$2,'Sample doctor message')",[consult.id,actors.doctor]);
    // Historical guardian provenance on a profile now owned by its adult patient.
    await q("insert into "+t("consents")+"(user_id,granted_by,authority,consent_type,policy_version,ip_hash) values($1,$2,'guardian','data_ingestion','historical-test',$3)",[subjects.alice,actors.doctor,hash]);
    await beginDeletion(actors.doctor);await owner();await q("update "+t("account_deletions")+" set stage='storage_removed' where account_id=$1",[actors.doctor]);await finishDeletion();
    await actAs(actors.alice);const [list]=await q("select "+fn("consult_list")+"($1,null,true) as v",[subjects.alice]);expect(list.v.rows[0]).toMatchObject({doctor_id:null,doctor_name:"Former doctor",doctor_note:"Sample preserved note",is_sample:true});
    const [room]=await q("select "+fn("consult_read")+"($1) as v",[consult.id]);expect(room.v.messages[0].sender_id).toBeNull();expect(room.v.is_sample).toBe(true);
    const [consent]=await q("select granted_by,authority,ip_hash from "+t("consents")+" where user_id=$1 and authority='guardian'",[subjects.alice]);expect(consent).toEqual({granted_by:null,authority:"guardian",ip_hash:""});
  });
  const care = async (subject:string,action:string,data:Record<string,unknown>) => (await q("select "+fn("care_change")+"($1,$2,$3::text::jsonb) as id",[subject,action,JSON.stringify(data)]))[0].id as string;
  const doctorRegistration={registrationNumber:"TEST-PENDING",council:"Test council",specialities:["General medicine"],languages:["English"],bio:"Sample doctor",feeInr:500,feeUsd:10,available:true};
  async function inviteCaregiver() {
    await owner(); await q("update auth.users set email_confirmed_at=now() where id=$1",[actors.bob]);
    await actAs(actors.alice);return care(subjects.alice,"invite_caregiver",{partnerId:actors.bob,scopes:["summary_only","alerts"]});
  }
  it("registers a pending doctor without trusting supplied verification or role fields",async()=>{
    await actAs(actors.bob);
    const [r]=await q("select "+fn("doctor_profile")+"('register',$1::text::jsonb) as d",[JSON.stringify({...doctorRegistration,verified_at:new Date().toISOString(),role:"admin",is_sample:true})]);
    expect(r.d.verified_at).toBeNull();expect(r.d.is_sample).toBe(false);
    const [p]=await q("select role from "+t("profiles")+" where id=$1",[subjects.bob]);expect(p.role).toBe("doctor");
    const [list]=await q("select "+fn("care_list")+"('directory') as d");expect(list.d.rows.map((d:{id:string})=>d.id)).toEqual([subjects.doctor]);
  });
  it("refuses doctor self-verification",async()=>{
    await actAs(actors.doctor);
    await expect(q("select "+fn("doctor_profile")+"('verify',$1::text::jsonb)",[JSON.stringify({doctorId:subjects.doctor})])).rejects.toMatchObject({code:"42501"});
  });
  it("allows only the database-admin role to verify and invalidates changed credentials",async()=>{
    await q("update "+t("profiles")+" set role='admin' where id=$1",[subjects.alice]);
    await actAs(actors.bob);await q("select "+fn("doctor_profile")+"('register',$1::text::jsonb)",[JSON.stringify(doctorRegistration)]);
    await actAs(actors.alice);const [verified]=await q("select "+fn("doctor_profile")+"('verify',$1::text::jsonb) as d",[JSON.stringify({doctorId:subjects.bob})]);expect(verified.d.verified_at).toBeTruthy();
    await actAs(actors.bob);
    const [same]=await q("select "+fn("doctor_profile")+"('register',$1::text::jsonb) as d",[JSON.stringify({...doctorRegistration,bio:"Updated bio"})]);expect(same.d.verified_at).toBeTruthy();
    const [changed]=await q("select "+fn("doctor_profile")+"('register',$1::text::jsonb) as d",[JSON.stringify({...doctorRegistration,registrationNumber:"CHANGED"})]);expect(changed.d.verified_at).toBeNull();
  });
  it("requires owner-selected sharing scopes and audits every doctor list read",async()=>{
    await actAs(actors.alice);await care(subjects.alice,"link_doctor",{partnerId:subjects.doctor,scopes:["full_history"]});
    await actAs(actors.doctor);
    for(let i=0;i<2;i++){const [r]=await q("select "+fn("care_list")+"('patients') as v");expect(r.v.rows).toHaveLength(1);expect(r.v.rows[0].id).toBe(subjects.alice);}
    const [history]=await q("select "+fn("patient_view")+"($1,'history') as v",[subjects.alice]);expect(history.v.can_manage).toBe(false);
    await owner();expect(await q("select id from "+t("audit_log")+" where actor_id=$1 and action='doctor_patient_list_read'",[actors.doctor])).toHaveLength(2);
  });
  it("requires sharing consent before a doctor can be linked",async()=>{
    await actAs(actors.bob);
    await expect(care(subjects.bob,"link_doctor",{partnerId:subjects.doctor,scopes:["summary_only"]})).rejects.toMatchObject({code:"42501"});
  });
  it("does not let a shared doctor change a patient's sharing links",async()=>{
    await actAs(actors.doctor);
    await expect(care(subjects.alice,"link_doctor",{partnerId:subjects.doctor,scopes:["full_history"]})).rejects.toMatchObject({code:"42501"});
  });
  it("requires the named caregiver to accept before any history access",async()=>{
    await inviteCaregiver();await actAs(actors.bob);
    const [r]=await q("select "+fn("care_list")+"('incoming') as v");expect(r.v.rows).toHaveLength(1);expect(r.v.rows[0].can_read_summary).toBe(false);
    await expect(q("select "+fn("patient_view")+"($1,'today')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("accepts a caregiver as read-only, audits views and requires reacceptance after scope changes",async()=>{
    const id=await inviteCaregiver();await actAs(actors.bob);await care(subjects.alice,"accept_caregiver",{linkId:id});
    const [r]=await q("select "+fn("patient_view")+"($1,'today') as v",[subjects.alice]);expect(r.v.can_manage).toBe(false);expect(r.v.can_read_history).toBe(false);expect(r.v.can_read_alerts).toBe(true);
    await actAs(actors.alice);await care(subjects.alice,"invite_caregiver",{partnerId:actors.bob,scopes:["full_history"]});
    await actAs(actors.bob);const [pending]=await q("select "+fn("care_list")+"('incoming') as v");expect(pending.v.rows[0].status).toBe("invited");expect(pending.v.rows[0].can_read_history).toBe(false);
    await owner();expect(await q("select id from "+t("audit_log")+" where actor_id=$1 and target_table='patient_view'",[actors.bob])).toHaveLength(1);
  });
  it("refuses another account's invitation acceptance",async()=>{
    const id=await inviteCaregiver();await actAs(actors.doctor);
    await expect(care(subjects.alice,"accept_caregiver",{linkId:id})).rejects.toMatchObject({code:"42501"});
  });
  it("revokes caregiver access on the next request",async()=>{
    const id=await inviteCaregiver();await actAs(actors.bob);await care(subjects.alice,"accept_caregiver",{linkId:id});
    await actAs(actors.alice);await care(subjects.alice,"revoke_caregiver",{linkId:id});
    await actAs(actors.bob);const [r]=await q("select "+fn("care_list")+"('incoming') as v");expect(r.v.rows).toEqual([]);
    await expect(q("select "+fn("patient_view")+"($1,'today')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("does not expose owner sharing lists to another account",async()=>{
    await actAs(actors.bob);
    await expect(q("select "+fn("care_list")+"('caregivers',$1)",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  const consultChange=async(subject:string,action:string,data:Record<string,unknown>)=>(await q("select "+fn("consult_change")+"($1,$2,$3::text::jsonb) as id",[subject,action,JSON.stringify(data)]))[0].id as string;
  async function requestConsult() {
    await owner();await q("update "+t("doctors")+" set available=true where id=$1",[subjects.doctor]);
    await actAs(actors.alice);
    const request={doctorId:subjects.doctor,type:"trend_review",note:" Sample trend question ",days:30,requestId:randomUUID()};
    const id=await consultChange(subjects.alice,"request",request);expect(await consultChange(subjects.alice,"request",request)).toBe(id);return id;
  }
  it("captures immutable summary snapshots without raw metrics and audits doctor downloads",async()=>{
    await actAs(actors.alice);
    await q("select "+fn("record_consent")+"($1,'data_ingestion',true,'test',$2)",[subjects.alice,hash]);
    await q("select "+fn("medications")+"($1,'[\"Sample medication - reported, not advice\"]')",[subjects.alice]);
    const [snap]=await q("select "+fn("clinical_summary")+"($1,30,null,true) as s",[subjects.alice]);expect(snap.s.id).toBeTruthy();expect(snap.s.body.series).toHaveLength(1);expect(snap.s.body.metrics).toBeUndefined();expect(snap.s.body.medications).toHaveLength(1);
    await owner();await q("update "+t("daily_summaries")+" set rhr=80 where user_id=$1",[subjects.alice]);
    await actAs(actors.doctor);const [frozen]=await q("select "+fn("clinical_summary")+"($1,30,$2,false) as s",[subjects.alice,snap.s.id]);expect(Number(frozen.s.body.series[0].rhr)).toBe(60);
    await owner();expect(await q("select id from "+t("audit_log")+" where actor_id=$1 and action='clinical_summary_read'",[actors.doctor])).toHaveLength(1);
  });
  it("requires processing consent before recording reported medications",async()=>{
    await actAs(actors.alice);
    await expect(q("select "+fn("medications")+"($1,'[\"Sample medication\"]')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("rejects clinical-PDF access for an ordinary summary-only caregiver",async()=>{
    const id=await inviteCaregiver();await actAs(actors.bob);await care(subjects.alice,"accept_caregiver",{linkId:id});
    await expect(q("select "+fn("clinical_summary")+"($1)",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("does not allow a shared doctor to create owner snapshots",async()=>{
    await actAs(actors.doctor);await expect(q("select "+fn("clinical_summary")+"($1,30,null,true)",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("preserves guardian consent provenance in a dependent's clinical snapshot",async()=>{
    await actAs(actors.guardian);const [child]=await q("select "+fn("create_dependent")+"('Sample child','2015-01-01','test',$1) as id",[hash]);
    await q("select "+fn("record_consent")+"($1,'doctor_sharing',true,'test',$2)",[child.id,hash]);
    await care(child.id,"link_doctor",{partnerId:subjects.doctor,scopes:["summary_only"]});
    const [snapshot]=await q("select "+fn("clinical_summary")+"($1,90,null,true) as s",[child.id]);
    await actAs(actors.doctor);const [view]=await q("select "+fn("clinical_summary")+"($1,90,$2,false) as s",[child.id,snapshot.s.id]);expect(view.s.body.consent_given_by_guardian).toBe(true);expect(view.s.body.profile.id).toBe(child.id);
  });
  it("completes the consult state machine, deduplicates retries and retains the note in History",async()=>{
    const id=await requestConsult();await actAs(actors.doctor);await consultChange(subjects.alice,"accept",{consultId:id});
    const message={consultId:id,messageId:randomUUID(),body:"Sample doctor message"};
    await consultChange(subjects.alice,"message",message);await consultChange(subjects.alice,"message",message);
    await actAs(actors.alice);await consultChange(subjects.alice,"message",{consultId:id,messageId:randomUUID(),body:"Sample patient message"});
    const [chat]=await q("select "+fn("consult_read")+"($1) as v",[id]);expect(chat.v.messages).toHaveLength(2);expect(chat.v.is_doctor).toBe(false);expect(chat.v.consult.attached_summary_id).toBeTruthy();
    await actAs(actors.doctor);await consultChange(subjects.alice,"close",{consultId:id,note:"Sample completed note. Discuss follow-up with your doctor."});
    await actAs(actors.alice);const [history]=await q("select "+fn("consult_list")+"($1,null,true) as v",[subjects.alice]);expect(history.v.rows[0].doctor_note).toContain("Sample completed note");expect(history.v.rows[0].status).toBe("completed");
  });
  it("refuses patient acceptance of their own consult",async()=>{
    const id=await requestConsult();await expect(consultChange(subjects.alice,"accept",{consultId:id})).rejects.toMatchObject({code:"42501"});
  });
  it("requires acceptance before exchanging chat messages",async()=>{
    const id=await requestConsult();await expect(consultChange(subjects.alice,"message",{consultId:id,messageId:randomUUID(),body:"Too early"})).rejects.toMatchObject({code:"22023"});
  });
  it("does not permit messages after closing a consult",async()=>{
    const id=await requestConsult();await actAs(actors.doctor);await consultChange(subjects.alice,"accept",{consultId:id});await consultChange(subjects.alice,"close",{consultId:id,note:"Sample note"});
    await actAs(actors.alice);await expect(consultChange(subjects.alice,"message",{consultId:id,messageId:randomUUID(),body:"Too late"})).rejects.toMatchObject({code:"22023"});
  });
  it("loses doctor chat and snapshot access when the patient revokes their link",async()=>{
    const id=await requestConsult();const [links]=await q("select "+fn("care_list")+"('doctors',$1) as v",[subjects.alice]);await care(subjects.alice,"revoke_doctor",{linkId:links.v.rows[0].id});
    const [own]=await q("select "+fn("consult_read")+"($1) as v",[id]);expect(own.v.consult.status).toBe("cancelled");
    await actAs(actors.doctor);const [list]=await q("select "+fn("consult_list")+"() as v");expect(list.v.rows).toEqual([]);
    await expect(q("select "+fn("consult_read")+"($1)",[id])).rejects.toMatchObject({code:"42501"});
  });
  it("cannot attach or inspect another patient's snapshot",async()=>{
    await actAs(actors.alice);const [s]=await q("select "+fn("clinical_summary")+"($1,30,null,true) as s",[subjects.alice]);
    await actAs(actors.bob);await expect(q("select "+fn("clinical_summary")+"($1,30,$2,false)",[subjects.bob,s.s.id])).rejects.toMatchObject({code:"42501"});
  });
  it("schedules a real supplied meeting link without creating a video service",async()=>{
    const id=await requestConsult();await actAs(actors.doctor);const future=new Date(Date.now()+86400000).toISOString();
    await consultChange(subjects.alice,"schedule",{consultId:id,scheduledFor:future,callUrl:"https://meet.google.com/abc-defg-hij"});
    await consultChange(subjects.alice,"accept",{consultId:id});
    const [r]=await q("select "+fn("consult_read")+"($1) as v",[id]);expect(r.v.consult.status).toBe("scheduled");expect(r.v.consult.call_url).toBe("https://meet.google.com/abc-defg-hij");
  });
  it("rejects unsafe call links at the database boundary",async()=>{
    const id=await requestConsult();await actAs(actors.doctor);
    await expect(consultChange(subjects.alice,"schedule",{consultId:id,scheduledFor:new Date(Date.now()+86400000).toISOString(),callUrl:"https://meet.google.com.evil.example/call"})).rejects.toMatchObject({code:"22023"});
  });
  async function transferFixture(){
    await owner();const [dates]=await q("select (current_date+1-interval '18 years')::date::text birth,(current_date+1)::text adult_day");
    await actAs(actors.guardian);const [child]=await q("select "+fn("create_dependent")+"('Sample almost-adult',$1,'test',$2) as id",[dates.birth,hash]);
    // Only rolled-back synthetic fixtures move to the future test date; production Auth has no clock override.
    await owner();await q("update "+t("profiles")+" set dob=$1 where id=$2",[dates.birth,subjects.bob]);await q("update auth.users set email_confirmed_at=now() where id=$1",[actors.bob]);
    return {subject:String(child.id),adult:dates.adult_day+"T12:00:00Z"};
  }
  const acceptance={acceptOwnership:true,replaceEmptyProfile:true,consent:true,disclaimer:true};
  async function transferAt(subject:string,action:string,data:Record<string,unknown>,at:string){
    // Database-owner verification only. The application role must be denied this helper.
    await owner();return (await q('select "'+privateSchema+'".transfer_at($1,$2,$3::text::jsonb,\'test\',$4,$5) as id',[subject,action,JSON.stringify(data),hash,at]))[0].id as string;
  }
  it("rejects guardian-initiated conversion before the eighteenth birthday",async()=>{
    const f=await transferFixture();await actAs(actors.guardian);
    await expect(q("select "+fn("transfer_change")+"($1,'offer',$2::text::jsonb,'test',$3)",[f.subject,JSON.stringify({recipientId:actors.bob,now:f.adult}),hash])).rejects.toMatchObject({code:"42501"});
  });
  it("does not expose the controlled-clock transfer helper to application roles",async()=>{
    const f=await transferFixture();await actAs(actors.guardian);
    await expect(q('select "'+privateSchema+'".transfer_at($1,\'offer\',$2::text::jsonb,\'test\',$3,$4)',[f.subject,JSON.stringify({recipientId:actors.bob}),hash,f.adult])).rejects.toMatchObject({code:"42501"});
  });
  it("transfers at eighteen without changing history IDs or historical guardian consent",async()=>{
    const f=await transferFixture();await actAs(actors.guardian);
    const [source]=await q("select "+fn("connect_source")+"($1,'generic_csv','transfer-test') as id",[f.subject]);
    await owner();await q("insert into "+t("metrics")+"(user_id,source_id,metric_type,value,unit,recorded_at) values($1,$2,'heart_rate',70,'bpm',now()-interval '1 day')",[f.subject,source.id]);
    await actAs(actors.guardian);const [snapshot]=await q("select "+fn("clinical_summary")+"($1,30,null,true) as s",[f.subject]);
    const offer=await transferAt(f.subject,"offer",{recipientId:actors.bob},f.adult);
    await actAs(actors.bob);await transferAt(f.subject,"accept",{offerId:offer,...acceptance},f.adult);
    await q("SET CONSTRAINTS ALL IMMEDIATE");
    const [p]=await q("select id,kind,auth_user_id,owner_account_id from "+t("profiles")+" where id=$1",[f.subject]);expect(p).toMatchObject({id:f.subject,kind:"self",auth_user_id:actors.bob,owner_account_id:actors.bob});
    expect(await q("select id from "+t("profiles")+" where id=$1",[subjects.bob])).toHaveLength(0);
    expect(await q("select id from "+t("metrics")+" where user_id=$1",[f.subject])).toHaveLength(1);
    const cs=await q("select authority,revoked_at from "+t("consents")+" where user_id=$1 order by granted_at",[f.subject]);expect(cs).toHaveLength(2);expect(cs[0].authority).toBe("guardian");expect(cs[0].revoked_at).toBeTruthy();expect(cs.at(-1)!.authority).toBe("self");expect(cs.at(-1)!.revoked_at).toBeNull();
    const [s]=await q("select body from "+t("summary_snapshots")+" where id=$1",[snapshot.s.id]);expect(s.body.consent_given_by_guardian).toBe(true);
    await actAs(actors.bob);const [read]=await q("select "+fn("patient_view")+"($1,'raw') as v",[f.subject]);expect(read.v.can_manage).toBe(true);expect(read.v.metrics).toHaveLength(1);
    await actAs(actors.guardian);await expect(q("select "+fn("patient_view")+"($1,'today')",[f.subject])).rejects.toMatchObject({code:"42501"});
  });
  it("refuses replacing an established recipient profile and keeps both profiles intact",async()=>{
    const f=await transferFixture();await actAs(actors.guardian);const id=await transferAt(f.subject,"offer",{recipientId:actors.bob},f.adult);
    await q("insert into "+t("data_sources")+"(user_id,provider) values($1,'generic_csv')",[subjects.bob]);
    await actAs(actors.bob);await q("SAVEPOINT transfer_attempt");
    await expect(transferAt(f.subject,"accept",{offerId:id,...acceptance},f.adult)).rejects.toMatchObject({code:"23514"});
    await q("ROLLBACK TO SAVEPOINT transfer_attempt");await owner();
    const profiles=await q("select id,owner_account_id from "+t("profiles")+" where id in ($1,$2)",[f.subject,subjects.bob]);
    expect(profiles).toHaveLength(2);expect(profiles.find(p=>p.id===f.subject)?.owner_account_id).toBe(actors.guardian);
    expect(profiles.find(p=>p.id===subjects.bob)?.owner_account_id).toBe(actors.bob);
    expect(await q("select id from "+t("data_sources")+" where user_id=$1",[subjects.bob])).toHaveLength(1);
    const [offer]=await q("select accepted_at from "+t("profile_transfers")+" where id=$1",[id]);expect(offer.accepted_at).toBeNull();
  });
  it("requires all explicit recipient confirmations",async()=>{
    const f=await transferFixture();await actAs(actors.guardian);const id=await transferAt(f.subject,"offer",{recipientId:actors.bob},f.adult);
    await actAs(actors.bob);await expect(transferAt(f.subject,"accept",{offerId:id,...acceptance,replaceEmptyProfile:false},f.adult)).rejects.toMatchObject({code:"23514"});
  });
  it("cannot accept a transfer offered to a different account",async()=>{
    const f=await transferFixture();await actAs(actors.guardian);const id=await transferAt(f.subject,"offer",{recipientId:actors.bob},f.adult);
    await actAs(actors.alice);await expect(transferAt(f.subject,"accept",{offerId:id,...acceptance},f.adult)).rejects.toMatchObject({code:"42501"});
  });
  it("expires unaccepted transfer offers after seven days",async()=>{
    const f=await transferFixture();await actAs(actors.guardian);const id=await transferAt(f.subject,"offer",{recipientId:actors.bob},f.adult);
    await actAs(actors.bob);await expect(transferAt(f.subject,"accept",{offerId:id,...acceptance},new Date(Date.parse(f.adult)+7*86400000).toISOString())).rejects.toMatchObject({code:"42501"});
  });
  it("pages patient history past a year without leaking raw data to summary-only doctors",async()=>{
    await q("insert into "+t("daily_summaries")+"(user_id,day,rhr) select $1,current_date-n,60 from generate_series(1,400) n",[subjects.alice]);
    await actAs(actors.alice);
    const [first]=await q("select "+fn("patient_view")+"($1,'history') as v",[subjects.alice]);
    expect(first.v.summaries).toHaveLength(365); expect(first.v.next_cursor.day).toBeTruthy();
    const [second]=await q("select "+fn("patient_view")+"($1,'history',null,null,$2::text::jsonb) as v",[subjects.alice,JSON.stringify(first.v.next_cursor)]);
    expect(second.v.summaries).toHaveLength(36); expect(second.v.next_cursor).toBeNull();
    expect(first.v.summaries.at(-1).day>second.v.summaries[0].day).toBe(true);
    await actAs(actors.doctor);
    const [summary]=await q("select "+fn("patient_view")+"($1,'today') as v",[subjects.alice]);
    expect(summary.v.summaries).toHaveLength(1); expect(summary.v.alerts).toBeUndefined(); expect(summary.v.can_manage).toBe(false);
    await expect(q("select "+fn("patient_view")+"($1,'raw')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("audits new scoped views and checks revoked access on the next call",async()=>{
    await actAs(actors.doctor); await q("select "+fn("patient_view")+"($1,'today')",[subjects.alice]);
    await owner();
    const [audit]=await q("select count(*)::int as n from "+t("audit_log")+" where actor_id=$1 and target_table='patient_view'",[actors.doctor]); expect(audit.n).toBe(1);
    await q("update "+t("doctor_patient_links")+" set status='revoked',revoked_at=now() where patient_id=$1",[subjects.alice]);
    await actAs(actors.doctor);
    await expect(q("select "+fn("patient_view")+"($1,'today')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("persists onboarding and requires explicit cycle opt-in and ingestion consent",async()=>{
    await actAs(actors.alice);
    await q("select "+fn("profile_settings")+"($1,'identity',$2::text::jsonb)",[subjects.alice,JSON.stringify({name:"Alice",dob:"1990-01-01",sex:"female",country:"IN",timezone:"Asia/Kolkata"})]);
    await q("select "+fn("profile_settings")+"($1,'complete','{\"disclaimer\":true}')",[subjects.alice]);
    await q("select "+fn("profile_settings")+"($1,'cycle','{\"enabled\":true}')",[subjects.alice]);
    await q("select "+fn("profile_settings")+"($1,'display','{\"mode\":\"advanced\"}')",[subjects.alice]);
    await q("select "+fn("record_consent")+"($1,'data_ingestion',true,'test',$2)",[subjects.alice,hash]);
    await q("select "+fn("profile_settings")+"($1,'period',$2::text::jsonb)",[subjects.alice,JSON.stringify({start:"2026-08-01",end:"2026-08-05"})]);
    const [p]=await q("select onboarding_completed_at,cycle_tracking_enabled,display_mode from "+t("profiles")+" where id=$1",[subjects.alice]);
    expect(p.onboarding_completed_at).toBeTruthy(); expect(p.cycle_tracking_enabled).toBe(true); expect(p.display_mode).toBe("advanced");
    const [log]=await q("select origin from "+t("cycle_logs")+" where user_id=$1",[subjects.alice]); expect(log.origin).toBe("manual");
  });
  it("re-buckets history when the home timezone changes after an import (OQ005)",async()=>{
    await actAs(actors.alice);
    await q("select "+fn("profile_settings")+"($1,'identity',$2::text::jsonb)",[subjects.alice,JSON.stringify({name:"Alice",dob:"1990-01-01",sex:"female",country:"IN",timezone:"Asia/Kolkata"})]);
    await owner(); await q("delete from "+t("summary_jobs")+" where user_id=$1",[subjects.alice]); await actAs(actors.alice);
    // The fixture metric is "now", so both zones bucket it within the two-day margin.
    await q("select "+fn("profile_settings")+"($1,'timezone','{\"timezone\":\"America/New_York\"}')",[subjects.alice]);
    await owner();
    const [p]=await q("select timezone,previous_timezone,timezone_changed_at from "+t("profiles")+" where id=$1",[subjects.alice]);
    expect(p.timezone).toBe("America/New_York");
    expect(p.previous_timezone).toBe("Asia/Kolkata");
    expect(p.timezone_changed_at).toBeTruthy();
    const jobs=await q("select day::text,rebucket from "+t("summary_jobs")+" where user_id=$1 and revision>processed_revision order by day",[subjects.alice]);
    expect(jobs.length).toBe(5);
    expect(jobs.every(j=>j.rebucket===true)).toBe(true);
    const [entry]=await q("select metadata from "+t("audit_log")+" where target_user_id=$1 and action='profile_timezone_rebucket'",[subjects.alice]);
    expect(entry.metadata.from).toBe("Asia/Kolkata"); expect(entry.metadata.to).toBe("America/New_York");
  });
  it("does not queue a re-bucket when the timezone is unchanged or no readings exist",async()=>{
    await actAs(actors.alice);
    await q("select "+fn("profile_settings")+"($1,'timezone','{\"timezone\":\"Asia/Kolkata\"}')",[subjects.alice]);
    await owner(); await q("delete from "+t("summary_jobs")+" where user_id=$1",[subjects.alice]); await actAs(actors.alice);
    await q("select "+fn("profile_settings")+"($1,'timezone','{\"timezone\":\"Asia/Kolkata\"}')",[subjects.alice]);
    await owner();
    expect(await q("select 1 from "+t("summary_jobs")+" where user_id=$1",[subjects.alice])).toHaveLength(0);
    const [p]=await q("select previous_timezone from "+t("profiles")+" where id=$1",[subjects.alice]);
    expect(p.previous_timezone).toBeNull();
    await actAs(actors.bob);
    await q("select "+fn("profile_settings")+"($1,'timezone','{\"timezone\":\"Europe/London\"}')",[subjects.bob]);
    await owner();
    expect(await q("select 1 from "+t("summary_jobs")+" where user_id=$1",[subjects.bob])).toHaveLength(0);
    const [b]=await q("select timezone,previous_timezone from "+t("profiles")+" where id=$1",[subjects.bob]);
    expect(b.timezone).toBe("Europe/London"); expect(b.previous_timezone).toBeNull();
  });
  it("rejects an unknown timezone",async()=>{
    await actAs(actors.alice);
    await expect(q("select "+fn("profile_settings")+"($1,'timezone','{\"timezone\":\"Mars/Olympus\"}')",[subjects.alice])).rejects.toMatchObject({code:"22023"});
  });
  it("does not let a different actor change a patient's timezone",async()=>{
    await actAs(actors.bob);
    await expect(q("select "+fn("profile_settings")+"($1,'timezone','{\"timezone\":\"Europe/London\"}')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("flags a doctor's snapshot when the patient has since changed timezone (OQ005)",async()=>{
    await actAs(actors.alice);
    const [made]=await q("select "+fn("clinical_summary")+"($1,30,null,true) as s",[subjects.alice]);
    expect(made.s.timezone_changed).toBe(false);
    const snapshotId=made.s.id;
    await q("select "+fn("profile_settings")+"($1,'timezone','{\"timezone\":\"America/New_York\"}')",[subjects.alice]);
    await actAs(actors.doctor);
    const [read]=await q("select "+fn("clinical_summary")+"($1,30,$2,false) as s",[subjects.alice,snapshotId]);
    expect(read.s.timezone_changed).toBe(true);
    expect(read.s.timezone).toBe("Asia/Kolkata");
    // The stored body is untouched: an immutable snapshot stays exactly as it was shared.
    expect(read.s.body.profile.timezone).toBe("Asia/Kolkata");
  });
  it("rejects a display density outside simple, standard and advanced",async()=>{
    await actAs(actors.alice);
    await expect(q("select "+fn("profile_settings")+"($1,'display','{\"mode\":\"dense\"}')",[subjects.alice])).rejects.toMatchObject({code:"22023"});
  });
  it("does not let a different actor edit a patient's identity",async()=>{
    await actAs(actors.bob);
    await expect(q("select "+fn("profile_settings")+"($1,'cycle','{\"enabled\":true}')",[subjects.alice])).rejects.toMatchObject({code:"42501"});
  });
  it("rejects changing an adult DOB into a minor through profile settings",async()=>{
    await actAs(actors.alice);
    await expect(q("select "+fn("profile_settings")+"($1,'identity',$2::text::jsonb)",[subjects.alice,JSON.stringify({name:"Alice",dob:"2015-01-01",sex:"female",country:"IN",timezone:"Asia/Kolkata"})])).rejects.toMatchObject({code:"22023"});
  });
  it("owner-scoped summary processing cannot claim another patient's jobs",async()=>{
    await q("insert into "+t("consents")+"(user_id,granted_by,authority,consent_type,policy_version,ip_hash) values($1,$2,'self','data_ingestion','test',$3)",[subjects.alice,actors.alice,hash]);
    await q("insert into "+t("summary_jobs")+"(user_id,day) values($1,current_date)",[subjects.alice]);
    const store=new PostgresSummaryStore(cx,{schema,ownerScope:{subject:subjects.alice,actor:actors.bob},transaction:async work=>work(cx)});
    expect(await store.claim(new Date(Date.now()+1000))).toBeNull();
  });
  it("point source lookup is scoped even when the source belongs to a different profile",async()=>{
    await actAs(actors.alice);
    const [result]=await q("select "+fn("patient_source")+"($1,$2) as s",[subjects.alice,source]);expect(result.s.id).toBe(source);
    await actAs(actors.bob);
    await expect(q("select "+fn("patient_source")+"($1,$2)",[subjects.bob,source])).rejects.toMatchObject({code:"42501"});
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
  it("registers native sources, makes batch retries idempotent and reports measured latency", async () => {
    await actAs(actors.alice);
    await q("select " + fn("record_consent") + "($1,'data_ingestion',true,'test',$2)", [subjects.alice, hash]);
    const installation = "ios:" + randomUUID();
    const [connected] = await q("select " + fn("connect_native_source") + "($1,'ios_healthkit',$2,'Sample iPhone',array['heart_rate','spo2'],$3) as id", [subjects.alice, installation, 60]);
    const batchId = randomUUID();
    // The suite runs in one transaction, so the ingestion guard's `now()` is
    // the transaction start even when this test executes several minutes later.
    const [databaseClock] = await q("select extract(epoch from now()) * 1000 as milliseconds");
    const metric = [{ metric_type: "heart_rate", value: 72, unit: "bpm", recorded_at: new Date(Number(databaseClock.milliseconds) - 120_000).toISOString(), duration_s: 60, quality: "raw", external_id: "healthkit:sample-1" }];
    const [first] = await q("select " + fn("ingest_native_batch") + "($1,$2,$3,$4::text::jsonb) as result", [subjects.alice, connected.id, batchId, JSON.stringify(metric)]);
    expect(first.result).toMatchObject({ inserted: 1, skipped: 0, batch_id: batchId, replayed: false });
    const [retry] = await q("select " + fn("ingest_native_batch") + "($1,$2,$3,$4::text::jsonb) as result", [subjects.alice, connected.id, batchId, JSON.stringify(metric)]);
    expect(retry.result).toMatchObject({ inserted: 1, skipped: 0, batch_id: batchId, replayed: true });
    await q("SAVEPOINT changed_native_batch");
    await expect(q("select " + fn("ingest_native_batch") + "($1,$2,$3,$4::text::jsonb)", [subjects.alice, connected.id, batchId, JSON.stringify([{ ...metric[0], value: 73 }])])).rejects.toMatchObject({ code: "22023" });
    await q("ROLLBACK TO SAVEPOINT changed_native_batch");
    const [report] = await q("select " + fn("latency_report") + "($1) as value", [subjects.alice]);
    expect(report.value.sources.find((item: { id: string }) => item.id === connected.id)).toMatchObject({ platform: "ios_healthkit", freshness: "current", cadence: 60 });
    expect(report.value.metrics.find((item: { source_id: string }) => item.source_id === connected.id)).toMatchObject({ metric_type: "heart_rate", count: 1 });
    await q("SAVEPOINT hidden_native_receipts");
    await expect(q('select * from "' + privateSchema + '"."native_ingestion_batches"')).rejects.toMatchObject({ code: "42501" });
    await q("ROLLBACK TO SAVEPOINT hidden_native_receipts");
    await actAs(actors.bob);
    await expect(q("select " + fn("latency_report") + "($1)", [subjects.alice])).rejects.toMatchObject({ code: "42501" });
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
  it("moves daily summaries onto the new local days when the timezone changes (OQ005)", async () => {
    await owner(); await q("delete from " + t("daily_summaries") + " where user_id=$1", [subjects.alice]);
    await q("delete from " + t("summary_jobs") + " where user_id=$1", [subjects.alice]);
    await q("update " + t("profiles") + " set timezone='UTC',previous_timezone=null,timezone_changed_at=null where id=$1", [subjects.alice]);
    await actAs(actors.alice); const id = await connect();
    // 22:00 UTC is 03:30 the following day in Asia/Kolkata, so every reading moves one day.
    await ingest(subjects.alice, id, Array.from({ length: 5 }, (_, i) => analyticsMetric(i + 1, "resting_heart_rate", 60, "bpm", "22")));
    await owner();
    const store = summaryStore();
    for (let pass = 0; pass < 10 && (await runSummaryJobs(store, { limit: 20, timeBudgetMs: 50000 })).completed; pass++);
    const before = await q("select day::text from " + t("daily_summaries") + " where user_id=$1 and rhr is not null order by day", [subjects.alice]);
    expect(before.map(r => r.day)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]);

    await actAs(actors.alice);
    await q("select " + fn("profile_settings") + "($1,'timezone','{\"timezone\":\"Asia/Kolkata\"}')", [subjects.alice]);
    await owner();
    expect(await q("select 1 from " + t("summary_jobs") + " where user_id=$1 and rebucket and revision>processed_revision", [subjects.alice])).not.toHaveLength(0);
    for (let pass = 0; pass < 10 && (await runSummaryJobs(store, { limit: 20, timeBudgetMs: 50000 })).completed; pass++);

    const after = await q("select day::text from " + t("daily_summaries") + " where user_id=$1 and rhr is not null order by day", [subjects.alice]);
    expect(after.map(r => r.day)).toEqual(["2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06"]);
    // Raw readings are absolute instants and never move.
    expect(await q("select 1 from " + t("metrics") + " where user_id=$1 and metric_type='resting_heart_rate'", [subjects.alice])).toHaveLength(5);
    // Every queued day was processed and the re-bucket flag cleared.
    expect(await q("select 1 from " + t("summary_jobs") + " where user_id=$1 and (rebucket or revision>processed_revision)", [subjects.alice])).toHaveLength(0);
  }, 120000);
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
  it("lets an alert-scoped caregiver configure a patient threshold and revokes that authority immediately", async () => {
    await owner();
    await q("insert into " + t("caregiver_links") + "(patient_id,caregiver_id,role,status,granted_scopes,invited_by) values($1,$2,'caregiver','active',array['summary_only','alerts']::" + t("sharing_scope") + "[],'patient')", [subjects.alice, actors.bob]);
    await actAs(actors.bob);
    const payload = JSON.stringify({ metricType: "spo2", comparator: "lt", thresholdType: "absolute", value: 90, duration: 60, severity: "urgent", enabled: true });
    const [saved] = await q("select " + fn("monitor_rules") + "($1,'upsert',$2::text::jsonb) as v", [subjects.alice, payload]);
    expect(saved.v.ok).toBe(true);
    const [read] = await q("select " + fn("monitor_rules") + "($1,'read') as v", [subjects.alice]);
    expect(read.v.rules).toHaveLength(1);
    expect(read.v.rules[0]).toMatchObject({ author_account_id: actors.bob, author_role: "caregiver", metric_type: "spo2", value: 90, can_edit: true });
    await actAs(actors.alice);
    await q("select " + fn("record_consent") + "($1,'data_ingestion',true,'test',$2)", [subjects.alice, hash]);
    const sourceId = await connect();
    const now = new Date(Date.now() + 1000);
    await ingest(subjects.alice, sourceId, [{ metric_type: "spo2", value: 89, unit: "%", recorded_at: new Date(now.getTime() - 11 * 60000).toISOString(), duration_s: 60, quality: "raw", external_id: null }]);
    await owner();
    expect((await runSummaryJobs(summaryStore(), { limit: 3, clock: () => now })).failed).toBe(0);
    const [alert] = await q("select id from " + t("alerts") + " where monitoring_rule_id=$1", [saved.v.id]);
    expect(alert).toBeTruthy();
    const deliveries = await q("select recipient_kind,recipient_key,channel from " + t("alert_deliveries") + " where alert_id=$1 order by recipient_kind,channel", [alert.id]);
    expect(deliveries).toEqual(expect.arrayContaining([
      { recipient_kind: "owner", recipient_key: actors.alice, channel: "email" },
      { recipient_kind: "owner", recipient_key: actors.alice, channel: "push" },
      { recipient_kind: "monitor", recipient_key: actors.bob, channel: "email" },
      { recipient_kind: "monitor", recipient_key: actors.bob, channel: "push" },
    ]));
    await actAs(actors.bob);
    const [deliveryStatus] = await q("select " + fn("monitor_delivery_status") + "($1) as v", [subjects.alice]);
    expect(deliveryStatus.v.channels).toEqual([
      { recipient: "Profile owner", is_current: false, email_enabled: false, push_enabled: false },
      { recipient: "You", is_current: true, email_enabled: false, push_enabled: false },
    ]);
    expect(deliveryStatus.v.activity[0]).toMatchObject({ id: alert.id, acknowledged_at: null });
    expect(deliveryStatus.v.activity[0].deliveries).toEqual(expect.arrayContaining([
      { recipient: "Profile owner", channel: "email", status: "pending", delivered_at: null },
      { recipient: "You", channel: "push", status: "pending", delivered_at: null },
    ]));
    await owner();
    await q("update " + t("caregiver_links") + " set status='revoked',revoked_at=now() where patient_id=$1 and caregiver_id=$2", [subjects.alice, actors.bob]);
    expect((await q("select enabled from " + t("monitoring_rules") + " where id=$1", [saved.v.id]))[0].enabled).toBe(false);
    expect((await q("select status from " + t("alert_deliveries") + " where alert_id=$1", [alert.id])).every(row => row.status === "cancelled")).toBe(true);
    await actAs(actors.bob);
    await expect(q("select " + fn("monitor_rules") + "($1,'read')", [subjects.alice])).rejects.toMatchObject({ code: "42501" });
  });
  it("requires alert scope for a verified doctor to configure monitoring", async () => {
    await actAs(actors.doctor);
    const payload = JSON.stringify({ metricType: "spo2", comparator: "lt", thresholdType: "absolute", value: 90, duration: 60, severity: "urgent", enabled: true });
    await q("SAVEPOINT doctor_monitor_attempt");
    await expect(q("select " + fn("monitor_rules") + "($1,'upsert',$2::text::jsonb)", [subjects.alice, payload])).rejects.toMatchObject({ code: "42501" });
    await q("ROLLBACK TO SAVEPOINT doctor_monitor_attempt");
    await owner();
    await q("update " + t("doctor_patient_links") + " set granted_scopes=array['summary_only','alerts']::" + t("sharing_scope") + "[] where patient_id=$1 and doctor_id=$2", [subjects.alice, subjects.doctor]);
    await actAs(actors.doctor);
    const [saved] = await q("select " + fn("monitor_rules") + "($1,'upsert',$2::text::jsonb) as v", [subjects.alice, payload]);
    expect(saved.v.ok).toBe(true);
  });
  it("lets adult profile owners and guardians manage monitoring rules, with database-enforced metric bounds", async () => {
    const valid = JSON.stringify({ metricType: "spo2", comparator: "lt", thresholdType: "absolute", value: 90, duration: 60, severity: "urgent", enabled: true });
    await actAs(actors.alice);
    expect((await q("select " + fn("monitor_rules") + "($1,'upsert',$2::text::jsonb) as v", [subjects.alice, valid]))[0].v.ok).toBe(true);
    await q("SAVEPOINT invalid_monitor_value");
    await expect(q("select " + fn("monitor_rules") + "($1,'upsert',$2::text::jsonb)", [subjects.alice, JSON.stringify({ ...JSON.parse(valid), value: 101 })])).rejects.toMatchObject({ code: "23514" });
    await q("ROLLBACK TO SAVEPOINT invalid_monitor_value");
    await actAs(actors.guardian);
    const [child] = await q("select " + fn("create_dependent") + "('Sample monitored child','2015-01-01','test',$1) as id", [hash]);
    expect((await q("select " + fn("monitor_rules") + "($1,'upsert',$2::text::jsonb) as v", [child.id, valid]))[0].v.ok).toBe(true);
    const [read] = await q("select " + fn("monitor_rules") + "($1,'read') as v", [child.id]);
    expect(read.v.rules[0]).toMatchObject({ author_role: "owner", can_edit: true });
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
