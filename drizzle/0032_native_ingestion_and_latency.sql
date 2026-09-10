CREATE TABLE hms_private.native_ingestion_batches (
  source_id uuid NOT NULL REFERENCES public.data_sources(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id,batch_id),
  CONSTRAINT native_batch_source_user_fk FOREIGN KEY (source_id,user_id)
    REFERENCES public.data_sources(id,user_id) ON DELETE CASCADE,
  CONSTRAINT native_batch_hash_shape CHECK (payload_hash ~ '^[0-9a-f]{32}$')
);--> statement-breakpoint
CREATE INDEX native_ingestion_batches_user_time_idx
  ON hms_private.native_ingestion_batches(user_id,received_at DESC);--> statement-breakpoint
REVOKE ALL ON hms_private.native_ingestion_batches FROM PUBLIC,anon,authenticated;--> statement-breakpoint

CREATE FUNCTION hms_private.connect_native_source(
  p_subject uuid,p_platform text,p_installation text,p_label text,p_metrics text[],p_cadence integer
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result uuid; stable_key text;
BEGIN
  PERFORM 1 FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF NOT hms_private.is_owner(p_subject) OR NOT EXISTS(
    SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='data_ingestion' AND revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'Ownership and ingestion consent required' USING ERRCODE='42501'; END IF;
  IF p_platform NOT IN ('ios_healthkit','android_health_connect')
    OR p_installation IS NULL OR length(p_installation) NOT BETWEEN 16 AND 128 OR p_installation !~ '^[A-Za-z0-9._:-]+$'
    OR p_label IS NULL OR length(trim(p_label)) NOT BETWEEN 1 AND 120
    OR p_cadence NOT BETWEEN 60 AND 86400
    OR coalesce(array_length(p_metrics,1),0) NOT BETWEEN 1 AND 21
    OR EXISTS(SELECT 1 FROM unnest(p_metrics) m WHERE m NOT IN (
      'heart_rate','resting_heart_rate','hrv_rmssd','spo2','skin_temperature','respiratory_rate','steps','active_calories',
      'total_calories','sleep_stage','sleep_duration','stress_score','weight_kg','body_fat_pct','blood_pressure_systolic',
      'blood_pressure_diastolic','blood_glucose','vo2max','menstrual_flow','basal_body_temperature'
    )) THEN RAISE EXCEPTION 'Invalid native source' USING ERRCODE='22023'; END IF;
  stable_key:='root:native:'||p_platform||':'||p_installation;
  INSERT INTO public.data_sources(user_id,provider,source_key,status,metadata)
    VALUES(p_subject,'aggregator',stable_key,'connected',jsonb_build_object(
      'label',trim(p_label),'sample',false,'connection','native','platform',p_platform,
      'metrics',to_jsonb(p_metrics),'expected_cadence_seconds',p_cadence
    ))
    ON CONFLICT(user_id,provider,source_key) DO UPDATE SET status='connected',metadata=excluded.metadata
    RETURNING id INTO result;
  IF NOT hms_private.is_self(p_subject) THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
      VALUES(auth.uid(),'guardian_native_source_connect',p_subject,'data_sources',result,jsonb_build_object('platform',p_platform));
  END IF;
  RETURN result;
END;
$fn$;--> statement-breakpoint

CREATE FUNCTION hms_private.ingest_native_batch(p_subject uuid,p_source uuid,p_batch uuid,p_metrics jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE fingerprint text; prior hms_private.native_ingestion_batches; outcome jsonb;
BEGIN
  IF p_batch IS NULL THEN RAISE EXCEPTION 'Batch id required' USING ERRCODE='22023'; END IF;
  -- This matches normal ingestion's first lock and serialises replay checks per subject.
  PERFORM 1 FROM public.profiles WHERE id=p_subject FOR UPDATE;
  fingerprint:=md5(coalesce(p_metrics,'null'::jsonb)::text);
  SELECT * INTO prior FROM hms_private.native_ingestion_batches WHERE source_id=p_source AND batch_id=p_batch;
  IF prior.batch_id IS NOT NULL THEN
    IF prior.user_id<>p_subject OR prior.payload_hash<>fingerprint THEN
      RAISE EXCEPTION 'Batch id reused with different content' USING ERRCODE='22023';
    END IF;
    RETURN prior.result || jsonb_build_object('replayed',true);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.data_sources WHERE id=p_source AND user_id=p_subject AND status='connected'
    AND provider='aggregator' AND metadata->>'connection'='native') THEN
    RAISE EXCEPTION 'Native source access denied' USING ERRCODE='42501';
  END IF;
  outcome:=hms_private.ingest_batch(p_subject,p_source,p_metrics)
    || jsonb_build_object('batch_id',p_batch,'replayed',false);
  INSERT INTO hms_private.native_ingestion_batches(source_id,batch_id,user_id,payload_hash,result)
    VALUES(p_source,p_batch,p_subject,fingerprint,outcome);
  RETURN outcome;
END;
$fn$;--> statement-breakpoint

CREATE FUNCTION hms_private.latency_report(p_subject uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;
BEGIN
  IF NOT hms_private.can_read(p_subject,'full_history') THEN
    RAISE EXCEPTION 'History access required' USING ERRCODE='42501';
  END IF;
  WITH source_rows AS (
    SELECT s.id,s.provider,s.metadata->>'label' label,s.metadata->>'connection' connection,
      s.metadata->>'platform' platform,s.last_sync_at,
      CASE WHEN (s.metadata->>'expected_cadence_seconds') ~ '^\d+$' THEN (s.metadata->>'expected_cadence_seconds')::integer
        WHEN s.provider IN ('google_health_api','whoop_api') THEN 60 END cadence,
      s.metadata->>'sample'='true' sample
    FROM public.data_sources s WHERE s.user_id=p_subject
  ), source_status AS (
    SELECT *,CASE WHEN cadence IS NULL THEN 'manual' WHEN last_sync_at IS NULL THEN 'waiting'
      WHEN extract(epoch FROM now()-last_sync_at)>greatest(cadence*3,300) THEN 'delayed' ELSE 'current' END freshness
    FROM source_rows
  ), metric_rows AS (
    SELECT m.source_id,m.metric_type::text metric_type,count(*) count,max(m.recorded_at) last_recorded_at,
      max(m.received_at) last_received_at,
      round(percentile_cont(.5) within group(order by greatest(0,extract(epoch FROM m.received_at-m.recorded_at)))::numeric,1) p50_source_seconds,
      round(percentile_cont(.95) within group(order by greatest(0,extract(epoch FROM m.received_at-m.recorded_at)))::numeric,1) p95_source_seconds
    FROM public.metrics m WHERE m.user_id=p_subject AND m.received_at>=now()-interval '30 days'
    GROUP BY m.source_id,m.metric_type
  ), alert_rows AS (
    SELECT round(percentile_cont(.5) within group(order by greatest(0,extract(epoch FROM a.fired_at-(a.metric_snapshot->>'recorded_at')::timestamptz)))::numeric,1) p50_seconds,
      round(percentile_cont(.95) within group(order by greatest(0,extract(epoch FROM a.fired_at-(a.metric_snapshot->>'recorded_at')::timestamptz)))::numeric,1) p95_seconds,
      count(*) count
    FROM public.alerts a WHERE a.user_id=p_subject AND a.fired_at>=now()-interval '30 days' AND a.metric_snapshot ? 'recorded_at'
  ), delivery_rows AS (
    SELECT round(percentile_cont(.5) within group(order by extract(epoch FROM d.delivered_at-a.fired_at))::numeric,1) p50_seconds,
      round(percentile_cont(.95) within group(order by extract(epoch FROM d.delivered_at-a.fired_at))::numeric,1) p95_seconds,
      count(*) count
    FROM public.alert_deliveries d JOIN public.alerts a ON a.id=d.alert_id
    WHERE d.user_id=p_subject AND d.delivered_at IS NOT NULL AND d.delivered_at>=now()-interval '30 days'
  )
  SELECT jsonb_build_object(
    'measured_at',now(),
    'sources',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.label,s.id) FROM source_status s),'[]'::jsonb),
    'metrics',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.last_received_at DESC,m.metric_type) FROM metric_rows m),'[]'::jsonb),
    'alerts',coalesce((SELECT to_jsonb(a) FROM alert_rows a),'{}'::jsonb),
    'deliveries',coalesce((SELECT to_jsonb(d) FROM delivery_rows d),'{}'::jsonb)
  ) INTO result;
  IF NOT hms_private.is_self(p_subject) THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id)
      VALUES(auth.uid(),CASE WHEN hms_private.is_owner(p_subject) THEN 'guardian_read' ELSE 'shared_read' END,p_subject,'latency_report',p_subject);
  END IF;
  RETURN result;
END;
$fn$;--> statement-breakpoint

CREATE FUNCTION public.hms_connect_native_source(p_subject uuid,p_platform text,p_installation text,p_label text,p_metrics text[],p_cadence integer)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.connect_native_source(p_subject,p_platform,p_installation,p_label,p_metrics,p_cadence); $fn$;--> statement-breakpoint
CREATE FUNCTION public.hms_ingest_native_batch(p_subject uuid,p_source uuid,p_batch uuid,p_metrics jsonb)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.ingest_native_batch(p_subject,p_source,p_batch,p_metrics); $fn$;--> statement-breakpoint
CREATE FUNCTION public.hms_latency_report(p_subject uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.latency_report(p_subject); $fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION hms_private.connect_native_source(uuid,text,text,text,text[],integer),
  hms_private.ingest_native_batch(uuid,uuid,uuid,jsonb),hms_private.latency_report(uuid),
  public.hms_connect_native_source(uuid,text,text,text,text[],integer),
  public.hms_ingest_native_batch(uuid,uuid,uuid,jsonb),public.hms_latency_report(uuid)
  FROM PUBLIC,anon,authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.hms_connect_native_source(uuid,text,text,text,text[],integer),
  public.hms_ingest_native_batch(uuid,uuid,uuid,jsonb),public.hms_latency_report(uuid) TO authenticated;--> statement-breakpoint
NOTIFY pgrst,'reload schema';
