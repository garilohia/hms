import { authenticatedClient } from "@/src/lib/auth/server";
import { streamedArchive } from "@/src/lib/data-rights/archive";
import { exportOwnedAccount } from "@/src/lib/data-rights/export";
import { privateHeaders, rightsDatabase } from "@/src/lib/data-rights/server";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in to export your data." }, { status: 401, headers: privateHeaders });
  const { error } = await session.client.rpc("hms_list_profiles");
  if (error) return Response.json({ error: "Data export is unavailable while account deletion is pending." }, { status: 403, headers: privateHeaders });
  const db = rightsDatabase();
  const archive = streamedArchive(async (writer, signal) => {
    try { await exportOwnedAccount(db, session.user.id, writer, signal); }
    finally { await db.end({ timeout: 5 }); }
  }, AbortSignal.any([request.signal, AbortSignal.timeout(270000)]));
  return new Response(archive.readable, { headers: { ...privateHeaders, "Content-Type": "application/zip",
    "Content-Disposition": 'attachment; filename="hms-data-' + new Date().toISOString().slice(0, 10) + '.zip"' } });
}
