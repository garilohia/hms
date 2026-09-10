import "server-only";
import { rightsDatabase, bindActor, lockOwnedSubject } from "../data-rights/server";
import { providerConfig } from "./providers";
import { seal, unseal } from "./crypto";
import type { NormalisedMetric } from "../ingestion/model";
import type { IntegrationProvider, IntegrationStatus, StoredTokens } from "./model";

const databaseProvider: Record<IntegrationProvider, "google_health_api" | "whoop_api"> = { google_health: "google_health_api", whoop: "whoop_api" };

export async function integrationStatuses(actor: string, subject: string): Promise<IntegrationStatus[]> {
  const db = rightsDatabase();
  try {
    const rows = await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject);
      return tx.unsafe("select c.provider, s.last_sync_at::text last_sync_at from hms_private.integration_connections c join public.data_sources s on s.id=c.source_id and s.user_id=c.user_id where c.user_id=$1", [subject]);
    });
    return (["google_health", "whoop"] as const).map(provider => ({
      provider,
      connected: rows.some(row => row.provider === provider),
      configured: Boolean(providerConfig(provider).clientId && providerConfig(provider).clientSecret && process.env.INTEGRATION_TOKEN_KEY),
      lastSyncAt: rows.find(row => row.provider === provider)?.last_sync_at ?? null,
      label: providerConfig(provider).label,
    }));
  } finally { await db.end(); }
}

export async function saveIntegration(actor: string, subject: string, provider: IntegrationProvider, externalId: string, scopes: string[], tokens: StoredTokens) {
  const db = rightsDatabase();
  try {
    await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      const [source] = await tx.unsafe("insert into public.data_sources(user_id,provider,source_key,status,metadata) values($1,$2::public.provider,$3,'connected',$4::jsonb) on conflict(user_id,provider,source_key) do update set status='connected', metadata=excluded.metadata returning id", [subject, databaseProvider[provider], `root:oauth:${provider}`, JSON.stringify({ label: providerConfig(provider).label, connection: "oauth" })]);
      await tx.unsafe("insert into hms_private.integration_connections(user_id,provider,source_id,external_account_id,encrypted_tokens,granted_scopes,token_expires_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,now()) on conflict(user_id,provider) do update set source_id=excluded.source_id,external_account_id=excluded.external_account_id,encrypted_tokens=excluded.encrypted_tokens,granted_scopes=excluded.granted_scopes,token_expires_at=excluded.token_expires_at,last_error=null,updated_at=now()", [subject, provider, source.id, externalId, seal(tokens), scopes, tokens.expiresAt || null]);
    });
  } finally { await db.end(); }
}

export async function removeIntegration(actor: string, subject: string, provider: IntegrationProvider) {
  const db = rightsDatabase();
  try {
    await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject);
      const rows = await tx.unsafe("delete from hms_private.integration_connections where user_id=$1 and provider=$2 returning source_id", [subject, provider]);
      if (rows[0]) await tx.unsafe("update public.data_sources set status='disconnected' where id=$1 and user_id=$2", [rows[0].source_id, subject]);
    });
  } finally { await db.end(); }
}

export async function loadIntegration(actor: string, subject: string, provider: IntegrationProvider) {
  const db = rightsDatabase();
  try {
    return await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      const [row] = await tx.unsafe("select c.source_id,c.encrypted_tokens,c.granted_scopes,p.timezone from hms_private.integration_connections c join public.profiles p on p.id=c.user_id where c.user_id=$1 and c.provider=$2 for update", [subject, provider]);
      if (!row) throw new Error("Connect this wearable first.");
      return { sourceId: String(row.source_id), timezone: String(row.timezone), scopes: Array.isArray(row.granted_scopes) ? row.granted_scopes.map(String) : [], tokens: unseal<StoredTokens>(String(row.encrypted_tokens)) };
    });
  } finally { await db.end(); }
}

export async function updateIntegrationTokens(actor: string, subject: string, provider: IntegrationProvider, tokens: StoredTokens) {
  const db = rightsDatabase();
  try {
    await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      await tx.unsafe("update hms_private.integration_connections set encrypted_tokens=$1,token_expires_at=$2,updated_at=now() where user_id=$3 and provider=$4", [seal(tokens), tokens.expiresAt || null, subject, provider]);
    });
  } finally { await db.end(); }
}

export async function persistIntegrationMetrics(actor: string, subject: string, sourceId: string, metrics: NormalisedMetric[]) {
  const db = rightsDatabase();
  let inserted = 0, skipped = 0;
  try {
    for (let offset = 0; offset < metrics.length; offset += 1000) {
      const batch = metrics.slice(offset, offset + 1000);
      await db.begin(async tx => {
        await bindActor(tx, actor);
        const [row] = await tx.unsafe("select public.hms_ingest_batch($1,$2,$3::jsonb) result", [subject, sourceId, JSON.stringify(batch)]);
        const result = row.result as { inserted: number; skipped: number };
        inserted += Number(result.inserted); skipped += Number(result.skipped);
      });
    }
    return { inserted, skipped };
  } finally { await db.end(); }
}
