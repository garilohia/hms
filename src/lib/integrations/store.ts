import "server-only";
import { rightsDatabase, bindActor, lockOwnedSubject, type Executor } from "../data-rights/server";
import { providerConfig, refreshAccessToken } from "./providers";
import { revokeProviderAccess } from "./revocation";
import { reconciliationComplete, syncCheckpoint } from "./checkpoint";
import { seal, unseal } from "./crypto";
import type { NormalisedMetric } from "../ingestion/model";
import type { IntegrationProvider, IntegrationStatus, StoredTokens } from "./model";
import { ProviderRateLimitError } from "./rate-limit";
import { ProviderBudgetDeferredError, providerQuotaConfigured } from "./request-budget";

const databaseProvider: Record<IntegrationProvider, "google_health_api" | "whoop_api"> = { google_health: "google_health_api", whoop: "whoop_api" };

export async function integrationStatuses(actor: string, subject: string): Promise<IntegrationStatus[]> {
  const db = rightsDatabase();
  try {
    const rows = await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject);
      return tx.unsafe("select c.provider, s.status, s.last_sync_at::text last_sync_at from hms_private.integration_connections c join public.data_sources s on s.id=c.source_id and s.user_id=c.user_id where c.user_id=$1", [subject]);
    });
    return (["google_health", "whoop"] as const).map(provider => ({
      provider,
      connected: rows.some(row => row.provider === provider && row.status === "connected"),
      revocationPending: rows.some(row => row.provider === provider && row.status === "disconnected"),
      configured: Boolean(providerConfig(provider).clientId && providerConfig(provider).clientSecret && process.env.INTEGRATION_TOKEN_KEY && providerQuotaConfigured(provider)),
      lastSyncAt: rows.find(row => row.provider === provider)?.last_sync_at ?? null,
      label: providerConfig(provider).label,
    }));
  } finally { await db.end(); }
}

type ConnectionGrant = { externalId: string; scopes: string[]; tokens: StoredTokens };

/** Serialise code exchange with disconnect and refresh so a revoke cannot target a replacement grant. */
export async function saveIntegration(actor: string, subject: string, provider: IntegrationProvider, exchange: () => Promise<ConnectionGrant>) {
  const db = rightsDatabase();
  try {
    await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      const [pending] = await tx.unsafe("select 1 from hms_private.integration_connections c join public.data_sources s on s.id=c.source_id where c.user_id=$1 and c.provider=$2 and s.status='disconnected'", [subject, provider]);
      if (pending) throw new Error("Finish removing provider access before connecting again.");
      const { externalId, scopes, tokens } = await exchange();
      const [source] = await tx.unsafe("insert into public.data_sources(user_id,provider,source_key,status,metadata) values($1,$2::public.provider,$3,'connected',$4::text::jsonb) on conflict(user_id,provider,source_key) do update set status='connected', metadata=excluded.metadata returning id", [subject, databaseProvider[provider], `root:oauth:${provider}`, JSON.stringify({ label: providerConfig(provider).label, connection: "oauth" })]);
      await tx.unsafe("insert into hms_private.integration_connections(user_id,provider,source_id,external_account_id,encrypted_tokens,granted_scopes,token_expires_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,now()) on conflict(user_id,provider) do update set source_id=excluded.source_id,external_account_id=excluded.external_account_id,encrypted_tokens=excluded.encrypted_tokens,granted_scopes=excluded.granted_scopes,token_expires_at=excluded.token_expires_at,last_error=null,next_sync_at=now(),sync_locked_until=null,sync_checkpoint=null,updated_at=now()", [subject, provider, source.id, externalId, seal(tokens), scopes, tokens.expiresAt || null]);
    });
  } finally { await db.end(); }
}

export async function removeIntegration(actor: string, subject: string, provider: IntegrationProvider, forgetAfterManualRevocation = false): Promise<{ revocationPending: boolean; connectionChanged?: boolean }> {
  const db = rightsDatabase();
  try {
    // Commit the local stop before any network call. No ingestion consent is
    // needed to disconnect, but current ownership is checked on every attempt.
    const attempt = await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject);
      const [row] = await tx.unsafe("select c.source_id,c.encrypted_tokens,c.last_error,s.status,(c.sync_locked_until>now()) busy from hms_private.integration_connections c join public.data_sources s on s.id=c.source_id where c.user_id=$1 and c.provider=$2 for update of c", [subject, provider]);
      if (!row) return { state: "removed" } as const;
      if (row.status === "disconnected" && row.last_error === "ProviderRevoking" && row.busy) return { state: "busy" } as const;
      if (forgetAfterManualRevocation) {
        if (row.status !== "disconnected") throw new Error("Disconnect in HMS before confirming removal in the provider's settings.");
        await tx.unsafe("delete from hms_private.integration_connections where user_id=$1 and provider=$2", [subject, provider]);
        return { state: "removed" } as const;
      }
      const lease = new Date(Date.now() + 30_000);
      await tx.unsafe("update hms_private.integration_connections set next_sync_at='infinity',sync_locked_until=$1,last_error='ProviderRevoking',updated_at=now() where user_id=$2 and provider=$3", [lease, subject, provider]);
      await tx.unsafe("update public.data_sources set status='disconnected' where id=$1 and user_id=$2", [row.source_id, subject]);
      return { state: "claimed", version: String(row.encrypted_tokens), lease } as const;
    });
    if (attempt.state !== "claimed") return { revocationPending: attempt.state === "busy" };
    try {
      // Pending state blocks reconnect; the lease blocks concurrent revocation
      // and manual removal. The remote request holds no patient/database lock.
      const result = await revokeProviderAccess(provider, unseal<StoredTokens>(attempt.version));
      return await db.begin(async tx => {
        await bindActor(tx, actor);
        await lockOwnedSubject(tx, subject);
        const [row] = await tx.unsafe("select 1 from hms_private.integration_connections c join public.data_sources s on s.id=c.source_id where c.user_id=$1 and c.provider=$2 and c.encrypted_tokens=$3 and c.sync_locked_until=$4 and c.last_error='ProviderRevoking' and s.status='disconnected' for update of c", [subject, provider, attempt.version, attempt.lease]);
        if (!row) return { revocationPending: true, connectionChanged: true };
        if (result.revoked) await tx.unsafe("delete from hms_private.integration_connections where user_id=$1 and provider=$2", [subject, provider]);
        else await tx.unsafe("update hms_private.integration_connections set encrypted_tokens=$1,token_expires_at=$2,sync_locked_until=null,last_error='ProviderRevokePending',updated_at=now() where user_id=$3 and provider=$4", [seal(result.tokens), result.tokens.expiresAt || null, subject, provider]);
        return { revocationPending: !result.revoked };
      });
    } catch {
      // A lost response, decryption failure or write failure must not claim that
      // provider access was removed. The already-committed local stop remains.
      return { revocationPending: true };
    }
  } finally { await db.end(); }
}

export async function loadIntegration(actor: string, subject: string, provider: IntegrationProvider) {
  const db = rightsDatabase();
  try {
    return await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      const [row] = await tx.unsafe("select c.source_id,c.encrypted_tokens,c.granted_scopes,c.sync_checkpoint,c.last_error,c.next_sync_at::text,p.timezone,s.last_sync_at::text from hms_private.integration_connections c join public.profiles p on p.id=c.user_id join public.data_sources s on s.id=c.source_id where c.user_id=$1 and c.provider=$2 and s.status='connected' for update of c", [subject, provider]);
      if (!row) throw new Error("Connect this wearable first.");
      return { sourceId: String(row.source_id), connectionVersion: String(row.encrypted_tokens), syncCheckpoint: row.sync_checkpoint as unknown, retryAt: activeCooldown(row), ...(row.last_error === "ProviderBudgetQueued" ? { budgetQueued: true } : {}), timezone: String(row.timezone), lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null, scopes: Array.isArray(row.granted_scopes) ? row.granted_scopes.map(String) : [], tokens: unseal<StoredTokens>(String(row.encrypted_tokens)) };
    });
  } finally { await db.end(); }
}

async function assertCurrentConnection(tx: Executor, subject: string, connectionVersion: string, selector: { provider: IntegrationProvider } | { sourceId: string }) {
  const [row] = await tx.unsafe(`select c.last_error,c.next_sync_at::text from hms_private.integration_connections c join public.data_sources s on s.id=c.source_id where c.user_id=$1 and c.encrypted_tokens=$2 and s.status='connected' and ${"provider" in selector ? "c.provider" : "c.source_id"}=$3 for update of c`, [subject, connectionVersion, "provider" in selector ? selector.provider : selector.sourceId]);
  if (!row) throw new Error("The wearable connection changed. Refresh this page before syncing again.");
  return row;
}

function activeCooldown(row: Record<string, unknown>): Date | null {
  if (row.last_error !== "ProviderRateLimited" && row.last_error !== "ProviderBudgetQueued") return null;
  const retryAt = new Date(String(row.next_sync_at));
  return Number.isFinite(retryAt.getTime()) && retryAt.getTime() > Date.now() ? retryAt : null;
}

function assertNoCooldown(row: Record<string, unknown>) {
  const retryAt = activeCooldown(row);
  if (retryAt) throw row.last_error === "ProviderBudgetQueued" ? new ProviderBudgetDeferredError(retryAt) : new ProviderRateLimitError(retryAt);
}

/** Recheck a cooldown established by another request before every provider page. */
export async function assertIntegrationReady(actor: string, subject: string, provider: IntegrationProvider, connectionVersion: string) {
  const db = rightsDatabase();
  try {
    await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      assertNoCooldown(await assertCurrentConnection(tx, subject, connectionVersion, { provider }));
    });
  } finally { await db.end(); }
}

// This protects this connection only, not the provider's aggregate client quota.
// Keep the current page and lease; the scheduler releases only its own lease.
export async function saveIntegrationCooldown(actor: string, subject: string, provider: IntegrationProvider, connectionVersion: string, retryAt: Date, reason: "ProviderRateLimited" | "ProviderBudgetQueued" = "ProviderRateLimited") {
  if (!Number.isFinite(retryAt.getTime())) throw new Error("Invalid wearable retry time.");
  const db = rightsDatabase();
  try {
    await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      await assertCurrentConnection(tx, subject, connectionVersion, { provider });
      await tx.unsafe("update hms_private.integration_connections set next_sync_at=greatest(next_sync_at,$1),last_error=case when last_error='ProviderRateLimited' and next_sync_at>now() then last_error else $4 end,updated_at=now() where user_id=$2 and provider=$3", [retryAt, subject, provider, reason]);
    });
  } finally { await db.end(); }
}

/** The refresh transaction committed this cooldown before releasing its grant lock. */
export class CommittedIntegrationCooldownError extends ProviderRateLimitError {}
export class CommittedIntegrationBudgetError extends ProviderBudgetDeferredError {}

export async function refreshIntegrationTokens(actor: string, subject: string, provider: IntegrationProvider, connectionVersion: string, deadline?: number) {
  const db = rightsDatabase();
  try {
    const outcome = await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      assertNoCooldown(await assertCurrentConnection(tx, subject, connectionVersion, { provider }));
      try {
        const tokens = await refreshAccessToken(provider, unseal<StoredTokens>(connectionVersion), deadline);
        const updatedVersion = seal(tokens);
        await tx.unsafe("update hms_private.integration_connections set encrypted_tokens=$1,token_expires_at=$2,updated_at=now() where user_id=$3 and provider=$4", [updatedVersion, tokens.expiresAt || null, subject, provider]);
        return { status: "refreshed" as const, tokens, connectionVersion: updatedVersion };
      } catch (error) {
        if (!(error instanceof ProviderRateLimitError)) throw error;
        // Returning, rather than throwing here, commits Retry-After while the
        // old grant is still locked. A waiting refresh must observe the delay
        // before it can rotate the token and invalidate an old-version write.
        const reason = error instanceof ProviderBudgetDeferredError ? "ProviderBudgetQueued" : "ProviderRateLimited";
        await tx.unsafe("update hms_private.integration_connections set next_sync_at=greatest(next_sync_at,$1),last_error=$4,updated_at=now() where user_id=$2 and provider=$3", [error.retryAt, subject, provider, reason]);
        return { status: "limited" as const, retryAt: error.retryAt, reason };
      }
    });
    if (outcome.status === "limited") throw outcome.reason === "ProviderBudgetQueued" ? new CommittedIntegrationBudgetError(outcome.retryAt) : new CommittedIntegrationCooldownError(outcome.retryAt);
    return { tokens: outcome.tokens, connectionVersion: outcome.connectionVersion };
  } finally { await db.end(); }
}

export async function markIntegrationSynced(actor: string, subject: string, provider: IntegrationProvider, connectionVersion: string, expectedCheckpoint: unknown) {
  const checkpoint = syncCheckpoint.parse(expectedCheckpoint);
  if (checkpoint.provider !== provider || !reconciliationComplete(checkpoint)) throw new Error("Finish all wearable pages before marking the sync complete.");
  const db = rightsDatabase();
  try {
    await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      await assertCurrentConnection(tx, subject, connectionVersion, { provider });
      const rows = await tx.unsafe("update hms_private.integration_connections c set next_sync_at=greatest(next_sync_at,now()+interval '1 minute'),sync_locked_until=null,sync_checkpoint=null,last_error=case when last_error in ('ProviderRateLimited','ProviderBudgetQueued') and next_sync_at>now() then last_error else null end,updated_at=now() where c.user_id=$1 and c.provider=$2 and c.sync_checkpoint is not distinct from $3::text::jsonb returning source_id", [subject, provider, JSON.stringify(checkpoint)]);
      if (!rows[0]) throw new Error("The wearable sync changed. Retry to continue.");
      // A long sweep only covers its frozen window, not the time it completes.
      await tx.unsafe("update public.data_sources set last_sync_at=$1 where id=$2 and user_id=$3", [checkpoint.window.end, rows[0].source_id, subject]);
    });
  } finally { await db.end(); }
}

export async function persistIntegrationMetrics(actor: string, subject: string, sourceId: string, metrics: NormalisedMetric[], connectionVersion: string) {
  const db = rightsDatabase();
  let inserted = 0, skipped = 0;
  try {
    for (let offset = 0; offset < metrics.length; offset += 1000) {
      const batch = metrics.slice(offset, offset + 1000);
      await db.begin(async tx => {
        await bindActor(tx, actor);
        await lockOwnedSubject(tx, subject, true);
        await assertCurrentConnection(tx, subject, connectionVersion, { sourceId });
        const [row] = await tx.unsafe("select public.hms_ingest_batch($1,$2,$3::text::jsonb) result", [subject, sourceId, JSON.stringify(batch)]);
        const result = row.result as { inserted: number; skipped: number };
        inserted += Number(result.inserted); skipped += Number(result.skipped);
      });
    }
    return { inserted, skipped };
  } finally { await db.end(); }
}
