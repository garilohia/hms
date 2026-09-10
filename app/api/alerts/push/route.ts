import { z } from "zod";
import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { rightsDatabase } from "@/src/lib/data-rights/server";
import { boundedJson } from "@/src/lib/ingestion/http";

const subscription = z.object({ endpoint: z.url().max(2048), keys: z.object({ p256dh: z.string().min(20).max(512), auth: z.string().min(8).max(256) }) }).strict();
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("subscribe"), subscription }).strict(),
  z.object({ action: z.literal("unsubscribe"), endpoint: z.url().max(2048) }).strict(),
]);

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = input.safeParse(await boundedJson(request, 8 * 1024).catch(() => null));
  if (!body.success) return Response.json({ error: "Invalid push subscription." }, { status: 400 });
  const db = rightsDatabase();
  try {
    if (body.data.action === "subscribe") {
      const value = body.data.subscription;
      const rows=await db.unsafe("insert into hms_private.push_subscriptions(account_id,endpoint,p256dh,auth) values($1,$2,$3,$4) on conflict(endpoint) do update set p256dh=excluded.p256dh,auth=excluded.auth,last_seen_at=now() where hms_private.push_subscriptions.account_id=excluded.account_id returning id", [session.user.id, value.endpoint, value.keys.p256dh, value.keys.auth]);
      if(!rows.length)return Response.json({error:"This push endpoint belongs to another account."},{status:403});
    } else {
      await db.unsafe("delete from hms_private.push_subscriptions where account_id=$1 and endpoint=$2", [session.user.id, body.data.endpoint]);
    }
    return Response.json({ ok: true });
  } catch { return Response.json({ error: "Push subscription could not be saved." }, { status: 503 }); }
  finally { await db.end(); }
}
