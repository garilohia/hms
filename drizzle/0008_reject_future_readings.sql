CREATE OR REPLACE FUNCTION hms_private.ingest_batch(p_subject uuid, p_source uuid, p_metrics jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE src public.data_sources; zone text; count_inserted integer; count_total integer;
BEGIN
  -- Consent changes use the same profile lock. A revoked consent cannot race a batch.
  SELECT timezone INTO zone FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF NOT hms_private.is_owner(p_subject) OR NOT EXISTS (
    SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='data_ingestion' AND revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'Ownership and ingestion consent required' USING ERRCODE='42501'; END IF;
  SELECT * INTO src FROM public.data_sources WHERE id=p_source AND user_id=p_subject AND status='connected' AND source_key LIKE 'root:%';
  IF src.id IS NULL THEN RAISE EXCEPTION 'Source access denied' USING ERRCODE='42501'; END IF;
  IF p_metrics IS NULL OR jsonb_typeof(p_metrics)<>'array' OR octet_length(p_metrics::text)>1048576 THEN
    RAISE EXCEPTION 'Expected a bounded metric array' USING ERRCODE='22023';
  END IF;
  count_total := jsonb_array_length(p_metrics);
  IF count_total NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Batch limit is 1000 records' USING ERRCODE='22023'; END IF;
  -- Revalidate at the DB boundary: clients can call RPCs without the Next API.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_metrics) j WHERE
      jsonb_typeof(j)<>'object' OR coalesce(jsonb_typeof(j->'value'),'null')<>'number'
      OR coalesce(jsonb_typeof(j->'metric_type'),'null')<>'string'
      OR coalesce(jsonb_typeof(j->'unit'),'null')<>'string'
      OR coalesce(j->>'recorded_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
      OR coalesce(j->>'quality','') NOT IN ('raw','derived','user_entered')
      OR length(coalesce(j->>'external_id',''))>200
      OR (j ? 'at_rest' AND jsonb_typeof(j->'at_rest') NOT IN ('boolean','null'))
      OR (j ? 'device' AND (jsonb_typeof(j->'device')<>'string' OR length(trim(j->>'device')) NOT BETWEEN 1 AND 200))) THEN
    RAISE EXCEPTION 'Malformed metric' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_metrics) AS m(metric_type public.metric_type, value numeric, unit text, duration_s numeric) WHERE
      value NOT BETWEEN -1000000000 AND 1000000000
      OR (duration_s IS NOT NULL AND (duration_s NOT BETWEEN 0 AND 604800 OR duration_s<>trunc(duration_s)))
      OR (metric_type='sleep_stage' AND (value NOT BETWEEN 0 AND 5 OR value<>trunc(value)))
      OR unit <> CASE metric_type
        WHEN 'heart_rate' THEN 'bpm' WHEN 'resting_heart_rate' THEN 'bpm' WHEN 'hrv_rmssd' THEN 'ms'
        WHEN 'spo2' THEN '%' WHEN 'skin_temperature' THEN '°C' WHEN 'respiratory_rate' THEN 'breaths/min'
        WHEN 'steps' THEN 'count' WHEN 'active_calories' THEN 'kcal' WHEN 'total_calories' THEN 'kcal'
        WHEN 'sleep_stage' THEN 'stage' WHEN 'sleep_duration' THEN 'min' WHEN 'stress_score' THEN 'score'
        WHEN 'weight_kg' THEN 'kg' WHEN 'body_fat_pct' THEN '%' WHEN 'blood_pressure_systolic' THEN 'mmHg'
        WHEN 'blood_pressure_diastolic' THEN 'mmHg' WHEN 'blood_glucose' THEN 'mg/dL'
        WHEN 'vo2max' THEN 'mL/kg/min' WHEN 'menstrual_flow' THEN 'category' WHEN 'basal_body_temperature' THEN '°C' END) THEN
    RAISE EXCEPTION 'Invalid metric value or unit' USING ERRCODE='22023';
  END IF;
  -- An imported record describes completed evidence, never a promised future interval.
  IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_metrics) AS m(recorded_at timestamptz,duration_s integer)
    WHERE m.recorded_at + coalesce(m.duration_s,0)*interval '1 second' > now()) THEN
    RAISE EXCEPTION 'Future readings are not accepted; check the device clock and retry later' USING ERRCODE='22023';
  END IF;
  -- Each Apple device has a stable source ID, independent of the ZIP filename.
  INSERT INTO public.data_sources(user_id,provider,source_key,metadata)
    SELECT DISTINCT p_subject,src.provider,p_source::text||':device:'||(j->>'device'),
      jsonb_build_object('label',j->>'device','parent',p_source,'sample',src.provider='simulator')
    FROM jsonb_array_elements(p_metrics) j WHERE j ? 'device'
    ON CONFLICT (user_id,provider,source_key) DO NOTHING;
  WITH added AS (
    INSERT INTO public.metrics(user_id,source_id,metric_type,value,unit,recorded_at,duration_s,at_rest,quality,external_id)
      SELECT p_subject,coalesce(d.id,p_source),m.metric_type,m.value,m.unit,m.recorded_at,m.duration_s,m.at_rest,m.quality,m.external_id
      FROM jsonb_to_recordset(p_metrics) AS m(metric_type public.metric_type,value numeric,unit text,recorded_at timestamptz,duration_s integer,at_rest boolean,quality public.metric_quality,external_id text,device text)
      LEFT JOIN public.data_sources d ON d.user_id=p_subject AND d.provider=src.provider AND d.source_key=p_source::text||':device:'||m.device
      ON CONFLICT (user_id,metric_type,recorded_at,source_id) DO NOTHING RETURNING recorded_at,duration_s
  ), queued AS (
    INSERT INTO public.summary_jobs(user_id,day)
      SELECT DISTINCT p_subject,days.day::date FROM added a
      CROSS JOIN LATERAL generate_series((a.recorded_at AT TIME ZONE zone)::date::timestamp,
        ((a.recorded_at + make_interval(secs => greatest(coalesce(a.duration_s,0)-0.001,0))) AT TIME ZONE zone)::date::timestamp,
        interval '1 day') AS days(day)
      ON CONFLICT (user_id,day) DO UPDATE SET revision=public.summary_jobs.revision+1,available_at=now()
      RETURNING id
  ) SELECT count(*) INTO count_inserted FROM added;
  UPDATE public.data_sources SET last_sync_at=now() WHERE id=p_source;
  IF NOT hms_private.is_self(p_subject) THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
      VALUES(auth.uid(),'guardian_ingest',p_subject,'metrics',p_source,jsonb_build_object('inserted',count_inserted));
  END IF;
  RETURN jsonb_build_object('inserted',count_inserted,'skipped',count_total-count_inserted);
END; $fn$;
NOTIFY pgrst,'reload schema';
