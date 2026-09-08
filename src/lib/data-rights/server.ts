import "server-only";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { checkedDocumentPath, DOCUMENT_BUCKET } from "./documents";

export const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export type Executor = Pick<postgres.Sql, "unsafe">;
export class AccessError extends Error {}

export function rightsDatabase() {
  if (!process.env.DATABASE_URL) throw new Error("Data service is not configured.");
  return postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connect_timeout: 5, onnotice() {},
    connection: { statement_timeout: 15000, lock_timeout: 5000, idle_in_transaction_session_timeout: 60000 } });
}

export function storageAdmin(signal?: AbortSignal) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Private storage is not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }) } });
}

/** Actor must come only from authenticatedClient().user.id, never request JSON. */
export async function bindActor(tx: Executor, verifiedActor: string) {
  z.uuid().parse(verifiedActor);
  await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)", [verifiedActor]);
}

export async function lockOwnedSubject(tx: Executor, subject: string, ingestion = false) {
  z.uuid().parse(subject);
  await tx.unsafe("select id from public.profiles where id=$1 for update", [subject]);
  // A separate statement sees a deletion fence/transfer committed while waiting.
  const [row] = await tx.unsafe("select hms_private.is_owner($1) allowed, exists(select 1 from public.consents where user_id=$1 and consent_type='data_ingestion' and revoked_at is null) consent", [subject]);
  if (!row?.allowed || (ingestion && !row.consent)) throw new AccessError("Current ownership and ingestion consent are required.");
}

export async function auditDocument(tx: Executor, actor: string, subject: string, document: string, action: string) {
  await tx.unsafe("insert into public.audit_log(actor_id,action,target_user_id,target_table,target_id) values($1,$2,$3,'documents',$4)", [actor, action, subject, document]);
}

export async function downloadStoredDocument(subject: string, path: string, signal?: AbortSignal) {
  const { data, error } = await storageAdmin(signal).storage.from(DOCUMENT_BUCKET).download(checkedDocumentPath(subject, path), {}, { cache: "no-store", signal });
  if (error || !data) throw new Error("The original document could not be downloaded. Try again.");
  return data;
}

const deletionIntent = z.object({ account_id: z.uuid(), profile_ids: z.array(z.uuid()), stage: z.enum(["pending", "storage_removed", "health_removed"]) });

/** Stages commit independently so external Storage/Auth failures remain retryable. */
export async function deleteOwnedAccount(db: postgres.Sql, actor: string, confirmDependents: boolean, signal: AbortSignal) {
  const admin = storageAdmin(signal);
  const intent = await db.begin(async tx => {
    await bindActor(tx, actor);
    const [row] = await tx.unsafe("select hms_private.begin_account_deletion($1) intent", [confirmDependents]);
    return deletionIntent.parse(row.intent);
  });
  if (intent.account_id !== actor) throw new AccessError("Account mismatch.");
  // No new owner upload can pass the committed fence. Include orphan files from
  // uncertain uploads, not just documents whose metadata transaction committed.
  await db.begin(async tx => {
    const [current] = await tx.unsafe("select stage from public.account_deletions where account_id=$1 for update", [actor]);
    if (!current || current.stage !== "pending") return;
    for (const subject of intent.profile_ids) {
      while (true) {
        signal.throwIfAborted();
        const objects = await tx.unsafe("select name from storage.objects where bucket_id=$1 and name like $2 order by name limit 500", [DOCUMENT_BUCKET, subject + "/%"]);
        if (!objects.length) break;
        const paths = z.array(z.object({ name: z.string() })).parse(objects).map(object => object.name);
        if (paths.some(path => !path.startsWith(subject + "/"))) throw new AccessError("Storage prefix mismatch.");
        const { error } = await admin.storage.from(DOCUMENT_BUCKET).remove(paths);
        if (error) throw new Error("Private document removal failed. Retry account deletion.");
      }
    }
    await tx.unsafe("update public.account_deletions set stage='storage_removed' where account_id=$1 and stage='pending'", [actor]);
  });
  await db.begin(async tx => {
    await bindActor(tx, actor);
    await tx.unsafe("select hms_private.finish_account_deletion()");
  });
  signal.throwIfAborted();
  const { error } = await admin.auth.admin.deleteUser(actor, false);
  // A concurrent retry may already have hard-deleted this exact Auth identity.
  if (error) {
    const stillExists = await db.unsafe("select 1 from auth.users where id=$1", [actor]);
    if (stillExists.length) throw new Error("Health data removed. Retry to finish deleting the account.");
  }
}
