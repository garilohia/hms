import "server-only";
import postgres from "postgres";
import { integrationProvider } from "./model";
import { syncIntegration } from "./sync";

type DueConnection = { userId: string; actor: string; provider: ReturnType<typeof integrationProvider.parse>; lease: Date };

async function claim(db: postgres.Sql, now: Date): Promise<DueConnection | null> {
  return db.begin(async tx => {
    const [row] = await tx.unsafe("select c.user_id,p.owner_account_id,c.provider from hms_private.integration_connections c join public.profiles p on p.id=c.user_id join public.data_sources s on s.id=c.source_id where s.status='connected' and c.next_sync_at<=$1 and (c.sync_locked_until is null or c.sync_locked_until<=$1) order by c.next_sync_at,c.user_id limit 1 for update of c skip locked", [now]);
    if (!row) return null;
    const lease = new Date(now.getTime() + 120_000);
    await tx.unsafe("update hms_private.integration_connections set sync_locked_until=$1 where user_id=$2 and provider=$3", [lease, row.user_id, row.provider]);
    return { userId: String(row.user_id), actor: String(row.owner_account_id), provider: integrationProvider.parse(row.provider), lease };
  }) as Promise<DueConnection | null>;
}

export async function syncDueIntegrations(db: postgres.Sql, options: { limit?: number; clock?: () => Date } = {}) {
  const result = { synced: 0, queued: 0, failed: 0, inserted: 0 };
  const deadline = Date.now() + 25_000;
  for (let index = 0; index < Math.min(options.limit ?? 1, 3); index++) {
    if (Date.now() >= deadline) break;
    const now = options.clock?.() ?? new Date(), due = await claim(db, now);
    if (!due) break;
    try {
      const sync = await syncIntegration(due.actor, due.userId, due.provider, { deadline });
      if (sync.complete) result.synced++; else result.queued++;
      result.inserted += sync.inserted;
      await db.unsafe("update hms_private.integration_connections c set sync_locked_until=null,next_sync_at=$1,last_error=null,updated_at=$2 from public.data_sources s where s.id=c.source_id and s.status='connected' and c.user_id=$3 and c.provider=$4 and c.sync_locked_until=$5", [new Date(now.getTime() + 60_000), now, due.userId, due.provider, due.lease]);
    } catch {
      result.failed++;
      await db.unsafe("update hms_private.integration_connections c set sync_locked_until=null,next_sync_at=$1,last_error='ProviderSyncFailed',updated_at=$2 from public.data_sources s where s.id=c.source_id and s.status='connected' and c.user_id=$3 and c.provider=$4 and c.sync_locked_until=$5", [new Date(now.getTime() + 5 * 60_000), now, due.userId, due.provider, due.lease]);
    }
  }
  return result;
}
