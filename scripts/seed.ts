import { randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { z } from "zod";
import { SimulatorAdapter, personas, type Persona } from "../src/lib/ingestion/simulator";
import type { IngestionTransport } from "../src/lib/ingestion/model";

nextEnv.loadEnvConfig(process.cwd());
async function main() {
  const env = z.object({ DATABASE_URL: z.string(), NEXT_PUBLIC_SUPABASE_URL: z.url(), SUPABASE_SECRET_KEY: z.string() }).parse(process.env);
  const db = postgres(env.DATABASE_URL, { max: 1, prepare: false });
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    for (const persona of Object.keys(personas) as Persona[]) {
      const p = personas[persona];
      const email = "hms-sample-" + persona + "@example.invalid";
      const [existing] = await db.unsafe("select id,raw_app_meta_data from auth.users where email=$1", [email]);
      if (existing && existing.raw_app_meta_data?.hms_seed !== true) throw new Error("Refusing to reuse an account not marked as an HMS seed fixture.");
      let actor = existing?.id as string | undefined;
      if (!actor) {
        const year = new Date().getUTCFullYear() - p.age;
        // Reserved-domain fixtures; no email is sent and no credential is printed.
        const result = await admin.auth.admin.createUser({ email, password: randomUUID() + randomUUID(), email_confirm: true,
          user_metadata: { name: p.name, dob: year + "-01-01" }, app_metadata: { hms_seed: true, hms_seed_version: 2 } });
        if (result.error) throw new Error("Could not create sample persona: " + result.error.code);
        actor = result.data.user.id;
      }
      const actorId = actor;
      const [profile] = await db.unsafe("select id,timezone from public.profiles where auth_user_id=$1", [actorId]);
      if (!profile) throw new Error("Sample profile is missing.");
      if (existing && existing.raw_app_meta_data.hms_seed_version !== 2) {
        await db.begin(async tx => {
          await tx.unsafe("select id from public.profiles where id=$1 for update", [profile.id]);
          const [protectedData] = await tx.unsafe("select exists(select 1 from public.data_sources where user_id=$1 and provider<>'simulator') or exists(select 1 from public.documents where user_id=$1) or exists(select 1 from public.consults where patient_id=$1) or exists(select 1 from public.cycle_logs where user_id=$1 and origin='manual') as present", [profile.id]);
          if (protectedData.present) throw new Error("Refusing to regenerate a seed profile containing non-sample data.");
          await tx.unsafe("delete from public.data_sources where user_id=$1 and provider='simulator'", [profile.id]);
          for (const table of ["daily_summaries", "baselines", "insights", "cycle_logs", "summary_jobs"]) await tx.unsafe("delete from public." + table + " where user_id=$1", [profile.id]);
        });
        const updated = await admin.auth.admin.updateUserById(actorId, { app_metadata: { ...existing.raw_app_meta_data, hms_seed: true, hms_seed_version: 2 } });
        if (updated.error) throw new Error("Could not version the regenerated sample fixture.");
        process.stdout.write("Regenerating only " + p.name + " with local-calendar sample dates.\n");
      }
      await db.unsafe("update public.profiles set sex_at_birth=$1 where id=$2", [p.sex, profile.id]);
      async function asActor(query: string, values: (string | number)[] = []) {
        return db.begin(async tx => {
          await tx.unsafe("SET LOCAL ROLE authenticated");
          await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)", [actorId]);
          return tx.unsafe(query, values);
        });
      }
      await asActor("select public.hms_record_consent($1,'data_ingestion',true,'sample-fixture',$2)", [profile.id, "0".repeat(64)]);
      const transport: IngestionTransport = {
        async connect(userId, provider, key) {
          const [row] = await asActor("select public.hms_connect_source($1,$2::text::public.provider,$3) as id", [userId, provider, key]);
          return { id: row.id, userId, provider, key };
        },
        async persist(source, metrics) {
          const [row] = await asActor("select public.hms_ingest_batch($1,$2,$3::text::jsonb) as result", [source.userId, source.id, JSON.stringify(metrics)]);
          return z.object({ inserted: z.number(), skipped: z.number() }).parse(row.result);
        },
      };
      const adapter = new SimulatorAdapter(transport, persona, 42, undefined, String(profile.timezone));
      const source = await adapter.connect(profile.id, null);
      const result = await adapter.sync(source);
      process.stdout.write(p.name + ": " + result.inserted + " inserted, " + result.skipped + " duplicates; profile " + profile.id + "\n");
    }
  } finally { await db.end(); }
}
main().catch(error => { process.stderr.write(error instanceof Error ? error.message + "\n" : "Sample seed failed.\n"); process.exitCode = 1; });
