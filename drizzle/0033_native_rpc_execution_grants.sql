-- Public SECURITY INVOKER wrappers still require permission to enter these
-- private SECURITY DEFINER functions. Each function performs its own live-user,
-- ownership/consent or scoped-read authorization check.
GRANT EXECUTE ON FUNCTION hms_private.connect_native_source(uuid,text,text,text,text[],integer),
  hms_private.ingest_native_batch(uuid,uuid,uuid,jsonb),
  hms_private.latency_report(uuid) TO authenticated;
