import { z } from "zod";
import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { boundedJson } from "@/src/lib/ingestion/http";
import { deleteOwnedAccount, privateHeaders, rightsDatabase } from "@/src/lib/data-rights/server";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403, headers: privateHeaders });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in to continue, or check whether your account was already deleted." }, { status: 401, headers: privateHeaders });
  const input = z.object({ confirmation: z.literal("DELETE"), confirmDependents: z.boolean() }).safeParse(await boundedJson(request, 2048).catch(() => null));
  if (!input.success) return Response.json({ error: "Type DELETE and confirm whether dependent profiles should also be deleted." }, { status: 400, headers: privateHeaders });
  const db = rightsDatabase();
  try {
    await deleteOwnedAccount(db, session.user.id, input.data.confirmDependents, AbortSignal.any([request.signal, AbortSignal.timeout(270000)]));
    await session.client.auth.signOut({ scope: "local" });
    return Response.json({ deleted: true }, { headers: privateHeaders });
  } catch {
    return Response.json({ error: "Deletion has not fully completed. Include dependent confirmation if applicable, then retry here. If deletion has started, data access remains frozen until it finishes." }, { status: 503, headers: privateHeaders });
  } finally { await db.end({ timeout: 5 }); }
}
