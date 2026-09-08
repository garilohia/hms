import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { DOCUMENT_BUCKET, documentMimeTypes, MAX_DOCUMENT_BYTES } from "../src/lib/data-rights/documents";
nextEnv.loadEnvConfig(process.cwd());

async function main() {
  const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: key, DATABASE_URL: database } = process.env;
  if (!url || !key || !database) throw new Error("Supabase configuration required.");
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(database, { max: 1, prepare: false });
  try {
    const [policy] = await db.unsafe("select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='hms_documents_routes_only' and permissive='RESTRICTIVE'");
    if (!policy) throw new Error("Apply HMS document access migration before configuring storage.");
    const { data: buckets, error: listError } = await admin.storage.listBuckets();
    if (listError) throw new Error("Could not inspect Storage buckets.");
    if (!buckets.some(bucket => bucket.id === DOCUMENT_BUCKET)) {
      const { error } = await admin.storage.createBucket(DOCUMENT_BUCKET, { public: false, fileSizeLimit: MAX_DOCUMENT_BYTES, allowedMimeTypes: [...documentMimeTypes] });
      if (error) throw new Error("Could not create private HMS document storage.");
    }
    const { data: bucket, error } = await admin.storage.getBucket(DOCUMENT_BUCKET);
    if (error || !bucket || bucket.public || Number(bucket.file_size_limit) !== MAX_DOCUMENT_BYTES ||
        !bucket.allowed_mime_types || bucket.allowed_mime_types.length !== documentMimeTypes.length ||
        documentMimeTypes.some(mime => !bucket.allowed_mime_types?.includes(mime))) {
      throw new Error("HMS bucket configuration differs. Refusing to alter an existing bucket automatically.");
    }
    process.stdout.write("Private hms-documents bucket verified: PDF/JPEG/PNG, 3 MiB, application routes only.\n");
  } finally { await db.end(); }
}
main().catch(error => { process.stderr.write((error instanceof Error ? error.message : "Storage setup failed.") + "\n"); process.exitCode = 1; });
