-- Even another permissive bucket policy cannot expose HMS health documents.
-- The server-only Storage key bypasses RLS; checked application routes enforce
-- ownership/sharing, current consent and audit before using that key.
CREATE POLICY hms_documents_routes_only ON storage.objects AS RESTRICTIVE
FOR ALL TO anon,authenticated USING (bucket_id <> 'hms-documents')
WITH CHECK (bucket_id <> 'hms-documents');
