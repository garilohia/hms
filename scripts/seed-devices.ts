import nextEnv from "@next/env";
import postgres from "postgres";
import { z } from "zod";
import { catalog } from "../src/lib/devices/catalog";
import { deviceSchema } from "../src/lib/devices/model";

nextEnv.loadEnvConfig(process.cwd());
async function main() {
  const env = z.object({ DATABASE_URL: z.string() }).parse(process.env);
  const db = postgres(env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 10 });
  try {
    const rows = catalog.map(row => deviceSchema.parse(row));
    await db.begin(async tx => {
      for (const row of rows) {
        // Update only named, sourced rows. Preserve their IDs and unrelated catalogue entries.
        await tx`insert into public.device_catalog ${tx(row)} on conflict (brand,model) do update set
          category=excluded.category,price_inr=excluded.price_inr,price_usd=excluded.price_usd,price_gbp=excluded.price_gbp,price_aed=excluded.price_aed,
          metrics_supported=excluded.metrics_supported,battery_days=excluded.battery_days,has_ecg=excluded.has_ecg,has_skin_temp=excluded.has_skin_temp,
          has_spo2=excluded.has_spo2,has_hrv=excluded.has_hrv,has_screen=excluded.has_screen,subscription_required=excluded.subscription_required,
          subscription_cost=excluded.subscription_cost,source_urls=excluded.source_urls,last_verified_at=excluded.last_verified_at,editorial_note=excluded.editorial_note`;
      }
      await tx.unsafe("SET LOCAL ROLE anon");
      for (const expected of rows) {
        const [stored] = await tx`select * from public.device_catalog where brand=${expected.brand} and model=${expected.model}`;
        const parsed = deviceSchema.parse({ ...stored, last_verified_at: stored.last_verified_at.toISOString() });
        if (JSON.stringify({ ...parsed, last_verified_at: new Date(parsed.last_verified_at).toISOString() }) !== JSON.stringify({ ...expected, last_verified_at: new Date(expected.last_verified_at).toISOString() })) throw new Error("Public catalogue round-trip did not match the verified source data.");
      }
    });
    process.stdout.write("Verified " + rows.length + " dated catalogue rows through anonymous RLS; unrelated rows preserved.\n");
  } finally { await db.end(); }
}
main().catch(() => { process.stderr.write("Device seed or public-read verification failed; catalogue transaction rolled back.\n"); process.exitCode = 1; });
