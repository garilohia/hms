import { randomUUID } from "node:crypto";
import { authenticatedClient, sameOrigin } from "@/src/lib/auth/server";
import { documentExtension, documentInput, DOCUMENT_BUCKET, readDocumentBody } from "@/src/lib/data-rights/documents";
import { AccessError, auditDocument, bindActor, lockOwnedSubject, privateHeaders, rightsDatabase, storageAdmin } from "@/src/lib/data-rights/server";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403, headers: privateHeaders });
  const session = await authenticatedClient();
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401, headers: privateHeaders });
  let titleHeader: string;
  try { titleHeader = decodeURIComponent(request.headers.get("x-hms-document-title") || ""); }
  catch { titleHeader = ""; }
  const input = documentInput.safeParse({ subject: request.headers.get("x-hms-profile"), type: request.headers.get("x-hms-document-type"), title: titleHeader });
  if (!input.success) return Response.json({ error: "Choose a profile, title and document type." }, { status: 400, headers: privateHeaders });
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await readDocumentBody(request); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Check the file." }, { status: 400, headers: privateHeaders }); }
  const mime = request.headers.get("content-type")!, id = randomUUID(), { subject, type, title } = input.data;
  const path = subject + "/" + id + "." + documentExtension(mime);
  const db = rightsDatabase();
  try {
    await db.begin(async tx => {
      await bindActor(tx, session.user.id); await lockOwnedSubject(tx, subject, true);
      // Keep the owner lock until Storage and metadata have both completed.
      // If a crash leaves an orphan, account deletion purges the whole prefix.
      const { error } = await storageAdmin(request.signal).storage.from(DOCUMENT_BUCKET).upload(path, bytes, { contentType: mime, upsert: false, cacheControl: "0" });
      if (error) throw new Error("Private storage unavailable.");
      await tx.unsafe("insert into public.documents(id,user_id,type,storage_path,title,mime_type,size_bytes) values($1,$2,$3,$4,$5,$6,$7)", [id, subject, type, path, title, mime, bytes.byteLength]);
      await auditDocument(tx, session.user.id, subject, id, "document_uploaded");
    });
    return Response.json({ id }, { headers: privateHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof AccessError ? error.message : "Document upload did not complete. Try again." }, { status: error instanceof AccessError ? 403 : 503, headers: privateHeaders });
  } finally { await db.end({ timeout: 5 }); }
}
