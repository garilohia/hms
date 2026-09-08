import "server-only";
import { TextReader } from "@zip.js/zip.js";
import { z } from "zod";
import type postgres from "postgres";
import { metricTypes } from "../ingestion/model";
import { byteStream, csvLine, jsonLines, type ArchiveWriter } from "./archive";
import { AccessError, bindActor, downloadStoredDocument, type Executor } from "./server";

const recordSchema = z.record(z.string(), z.unknown());
const profileSchema = z.object({ id: z.uuid(), kind: z.enum(["self", "dependent"]) });
const metricSchema = z.object({ id: z.uuid(), source_id: z.uuid(), metric_type: z.string(), value: z.coerce.number().finite(),
  unit: z.string(), recorded_at: z.string(), duration_s: z.number().nullable(), at_rest: z.boolean().nullable(),
  quality: z.string(), external_id: z.string().nullable(), provider: z.string(), is_sample: z.boolean(), source_label: z.string().nullable() });

/** Fixed internal SQL fragments only. Cursor paging bounds row buffers to 500. */
async function* records(tx: Executor, table: string, predicate: string, subject: string, signal: AbortSignal) {
  let cursor: string | null = null;
  while (true) {
    signal.throwIfAborted();
    const rows = await tx.unsafe("select t.* from public." + table + " t where " + predicate + " and ($2::uuid is null or t.id>$2) order by t.id limit 500", [subject, cursor]);
    for (const row of rows) yield recordSchema.parse(row);
    if (rows.length < 500) break;
    cursor = z.uuid().parse(rows.at(-1)?.id);
  }
}

async function* metricsCsv(tx: Executor, subject: string, metric: string, signal: AbortSignal) {
  const encoder = new TextEncoder();
  yield encoder.encode(csvLine(["timestamp", "metric_type", "value", "unit", "duration_s", "at_rest", "quality", "external_id", "source_id", "provider", "source_label", "is_sample", "profile_id", "metric_id"]));
  let recorded: string | null = null, source: string | null = null;
  while (true) {
    signal.throwIfAborted();
    const rows = await tx.unsafe("select m.*,to_char(m.recorded_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') recorded_at,s.provider,s.metadata->>'label' source_label,(s.provider='simulator') is_sample from public.metrics m join public.data_sources s on s.id=m.source_id where m.user_id=$1 and m.metric_type=$2 and ($3::timestamptz is null or (m.recorded_at,m.source_id)>($3,$4::uuid)) order by m.recorded_at,m.source_id limit 500", [subject, metric, recorded, source]);
    let chunk = "";
    for (const row of rows) {
      const m = metricSchema.parse(row);
      chunk += csvLine([m.recorded_at, m.metric_type, m.value, m.unit, m.duration_s, m.at_rest, m.quality, m.external_id, m.source_id, m.provider, m.source_label, m.is_sample, subject, m.id]);
      recorded = m.recorded_at; source = m.source_id;
    }
    if (chunk) yield encoder.encode(chunk);
    if (rows.length < 500) break;
  }
}

export async function exportOwnedAccount(db: postgres.Sql, actor: string, writer: ArchiveWriter, signal: AbortSignal) {
  await db.begin(async tx => {
    await bindActor(tx, actor);
    // Match deletion/dependent creation. Transfers and ingestion also lock the
    // affected profile, so ownership cannot change halfway through this archive.
    await tx.unsafe("select id from public.profiles where auth_user_id=$1 for update", [actor]);
    const locked = await tx.unsafe("select id,kind from public.profiles where owner_account_id=$1 order by id for update", [actor]);
    const profiles = z.array(profileSchema).parse(locked);
    const [live] = await tx.unsafe("select hms_private.actor_is_live() live");
    if (!live?.live || !profiles.length) throw new AccessError("This account cannot export data.");
    for (const profile of profiles) {
      const [owned] = await tx.unsafe("select hms_private.is_owner($1) allowed", [profile.id]);
      if (!owned?.allowed) throw new AccessError("Profile ownership changed. Start a new export.");
      // Persist before bytes leave. A cancelled guardian export is still audited.
      await db.unsafe("insert into public.audit_log(actor_id,action,target_user_id,target_table,target_id) values($1,'account_export_started',$2,'profiles',$2)", [actor, profile.id]);
    }
    await writer.add("README.txt", new TextReader("HMS account export\nGenerated: " + new Date().toISOString() + "\nIncludes only profiles currently owned by this account. Linked patients are excluded.\nEach metric has its own CSV. Additional records use JSON Lines (one JSON object per line). Original documents are in each profile's documents folder.\nSample data is explicitly marked by provider=simulator and is_sample=true. Do not relabel it as real data. This archive is a record copy, not an HMS account backup/restore format.\nText starting with spreadsheet formula characters is prefixed with an apostrophe in CSV. JSON records preserve original text.\nProfile ownership is locked during export. Mutable consultation messages and audit records reflect when their section is read, not a single point-in-time database backup.\nGenerated from consumer wearable data; not a medical device.\n"), { signal });
    for (const profile of profiles) {
      const prefix = "profiles/" + profile.id + "/";
      await writer.add(prefix + "profile.jsonl", byteStream(jsonLines(records(tx, "profiles", "t.id=$1", profile.id, signal)), signal), { signal });
      for (const metric of metricTypes) await writer.add(prefix + "metrics/" + metric + ".csv", byteStream(metricsCsv(tx, profile.id, metric, signal), signal), { signal });
      for (const table of ["consents", "data_sources", "daily_summaries", "baselines", "alerts", "insights", "cycle_logs", "summary_snapshots", "documents", "profile_transfers"]) {
        await writer.add(prefix + table + ".jsonl", byteStream(jsonLines(records(tx, table, "t.user_id=$1", profile.id, signal)), signal), { signal });
      }
      for (const [table, predicate] of [
        ["doctors", "t.id=$1"], ["alert_rules", "t.user_id=$1"],
        ["doctor_patient_links", "t.patient_id=$1"], ["caregiver_links", "t.patient_id=$1"],
        ["consults", "t.patient_id=$1"], ["messages", "t.consult_id in(select id from public.consults where patient_id=$1)"],
        ["audit_log", "t.target_user_id=$1"],
      ]) await writer.add(prefix + table + ".jsonl", byteStream(jsonLines(records(tx, table, predicate, profile.id, signal)), signal), { signal });
      for await (const record of records(tx, "documents", "t.user_id=$1", profile.id, signal)) {
        const document = z.object({ id: z.uuid(), storage_path: z.string() }).parse(record);
        const blob = await downloadStoredDocument(profile.id, document.storage_path, signal);
        await writer.add(prefix + "documents/" + document.storage_path.split("/")[1], blob.stream(), { signal });
      }
    }
  });
}
