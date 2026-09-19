import "server-only";
import { bindActor, lockOwnedSubject, rightsDatabase } from "../data-rights/server";
import { syncCheckpoint, type SyncCheckpoint } from "./checkpoint";
import type { IntegrationProvider } from "./model";

// Persist only after the page's metrics commit. A crash before this write safely
// replays the same page through the canonical ingestion dedupe boundary.
export async function saveIntegrationCheckpoint(actor: string, subject: string, provider: IntegrationProvider, connectionVersion: string, expected: SyncCheckpoint | null, next: SyncCheckpoint) {
  const value = syncCheckpoint.parse(next);
  if (value.provider !== provider) throw new Error("Provider checkpoint does not match the connection.");
  const db = rightsDatabase();
  try {
    await db.begin(async tx => {
      await bindActor(tx, actor);
      await lockOwnedSubject(tx, subject, true);
      const rows = await tx.unsafe(`update hms_private.integration_connections c set sync_checkpoint=$1::text::jsonb,updated_at=now()
        from public.data_sources s where c.user_id=$2 and c.provider=$3 and c.encrypted_tokens=$4
        and c.sync_checkpoint is not distinct from $5::text::jsonb and s.id=c.source_id and s.user_id=c.user_id and s.status='connected'
        returning c.user_id`, [JSON.stringify(value), subject, provider, connectionVersion, expected ? JSON.stringify(expected) : null]);
      if (!rows.length) throw new Error("Wearable connection or sync checkpoint changed. Retry the current connection.");
    });
  } finally { await db.end(); }
}
