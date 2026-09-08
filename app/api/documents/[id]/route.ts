import { z } from "zod";
import { authenticatedClient } from "@/src/lib/auth/server";
import { documentExtension } from "@/src/lib/data-rights/documents";
import { AccessError, auditDocument, bindActor, downloadStoredDocument, privateHeaders, rightsDatabase } from "@/src/lib/data-rights/server";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401, headers: privateHeaders });
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return Response.json({ error: "Document unavailable." }, { status: 404, headers: privateHeaders });
  const db = rightsDatabase();
  try {
    const file = await db.begin(async tx => {
      await bindActor(tx, session.user.id);
      // Unchecked rows never leave this server transaction.
      const [document] = await tx.unsafe("select user_id,storage_path,mime_type from public.documents where id=$1", [id.data]);
      if (!document) throw new AccessError();
      const subject = z.uuid().parse(document.user_id);
      const check = async () => {
        const [scope] = await tx.unsafe("select hms_private.can_read($1,'full_history') allowed", [subject]);
        if (!scope?.allowed) throw new AccessError();
      };
      await check();
      const blob = await downloadStoredDocument(subject, String(document.storage_path), request.signal);
      await check(); // A revoked link never yields an original document after waiting on Storage.
      await auditDocument(tx, session.user.id, subject, id.data, "document_downloaded");
      return { blob, mime: String(document.mime_type || "application/octet-stream") };
    });
    return new Response(file.blob, { headers: { ...privateHeaders, "Content-Type": file.mime,
      "Content-Disposition": 'attachment; filename="document-' + id.data + '.' + documentExtension(file.mime) + '"',
      "Content-Security-Policy": "sandbox; default-src 'none'" } });
  } catch (error) { return Response.json({ error: "Document unavailable. Check access and try again." }, { status: error instanceof AccessError ? 404 : 503, headers: privateHeaders }); }
  finally { await db.end({ timeout: 5 }); }
}
