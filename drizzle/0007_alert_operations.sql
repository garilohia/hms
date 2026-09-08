-- Private outbox is never readable/writable through the Data API.
REVOKE ALL ON public.alert_deliveries FROM PUBLIC,anon,authenticated;
INSERT INTO public.alert_rules(id,rule_key,metric_type,comparator,threshold_type,value,min_duration_s,severity) VALUES
('00000000-0000-4000-a000-000000000001','spo2-urgent','spo2','lt','absolute',90,600,'urgent'),
('00000000-0000-4000-a000-000000000002','spo2-attention','spo2','lt','absolute',92,1800,'attention'),
('00000000-0000-4000-a000-000000000003','rhr-high','resting_heart_rate','gt','baseline_deviation',4,1800,'attention'),
('00000000-0000-4000-a000-000000000004','hr-high','heart_rate','gt','absolute',150,300,'urgent'),
('00000000-0000-4000-a000-000000000005','hr-low','heart_rate','lt','absolute',40,300,'urgent'),
('00000000-0000-4000-a000-000000000006','temp-shift','skin_temperature','gt','absolute',1,7200,'attention'),
('00000000-0000-4000-a000-000000000007','bp-systolic','blood_pressure_systolic','gte','absolute',180,0,'urgent'),
('00000000-0000-4000-a000-000000000008','bp-diastolic','blood_pressure_diastolic','gte','absolute',120,0,'urgent');
-- Evaluate existing imported days once under the new alert rules.
UPDATE public.summary_jobs SET revision=revision+1,available_at=now();
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

CREATE FUNCTION hms_private.alert_settings(p_subject uuid,p_action text,p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb; system_rule public.alert_rules; target uuid; email text;
BEGIN
  PERFORM 1 FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF NOT hms_private.is_owner(p_subject) THEN RAISE EXCEPTION 'Owner access required' USING ERRCODE='42501'; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>4096 THEN
    RAISE EXCEPTION 'Invalid settings' USING ERRCODE='22023';
  END IF;
  IF p_action='acknowledge' THEN
    target := (p_payload->>'alertId')::uuid;
    UPDATE public.alerts SET acknowledged_at=coalesce(acknowledged_at,now()) WHERE id=target AND user_id=p_subject;
    IF NOT FOUND THEN RAISE EXCEPTION 'Alert not found' USING ERRCODE='42501'; END IF;
    UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL WHERE alert_id=target AND status='pending';
    result := '{"ok":true}'::jsonb;
  ELSIF p_action IN ('rule','reset_rule') THEN
    SELECT * INTO system_rule FROM public.alert_rules WHERE user_id IS NULL AND rule_key=p_payload->>'key';
    IF system_rule.id IS NULL THEN RAISE EXCEPTION 'Unknown rule' USING ERRCODE='22023'; END IF;
    IF p_action='reset_rule' THEN
      DELETE FROM public.alert_rules WHERE user_id=p_subject AND rule_key=system_rule.rule_key;
    ELSE
      IF jsonb_typeof(p_payload->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_payload->'value') IS DISTINCT FROM 'number'
        OR jsonb_typeof(p_payload->'duration') IS DISTINCT FROM 'number'
        OR (p_payload->>'value')::numeric NOT BETWEEN 0 AND 10000
        OR (p_payload->>'duration')::numeric NOT BETWEEN 0 AND 86400
        OR (p_payload->>'duration')::numeric <> trunc((p_payload->>'duration')::numeric) THEN
        RAISE EXCEPTION 'Invalid threshold' USING ERRCODE='22023';
      END IF;
      INSERT INTO public.alert_rules(user_id,rule_key,metric_type,comparator,threshold_type,value,min_duration_s,severity,enabled)
        VALUES(p_subject,system_rule.rule_key,system_rule.metric_type,system_rule.comparator,system_rule.threshold_type,
          (p_payload->>'value')::numeric,(p_payload->>'duration')::integer,system_rule.severity,(p_payload->>'enabled')::boolean)
        ON CONFLICT(user_id,rule_key) DO UPDATE SET value=excluded.value,min_duration_s=excluded.min_duration_s,enabled=excluded.enabled;
    END IF;
    UPDATE public.summary_jobs SET revision=revision+1,available_at=now() WHERE user_id=p_subject
      AND day >= (SELECT max(day)-1 FROM public.summary_jobs WHERE user_id=p_subject);
    UPDATE public.alerts SET escalation_processed_at=coalesce(escalation_processed_at,now())
      WHERE user_id=p_subject AND metric_snapshot->>'rule_key'=system_rule.rule_key;
    UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL
      WHERE user_id=p_subject AND status='pending' AND alert_id IN
        (SELECT id FROM public.alerts WHERE user_id=p_subject AND metric_snapshot->>'rule_key'=system_rule.rule_key);
    result := '{"ok":true}'::jsonb;
  ELSIF p_action='contact' THEN
    email := lower(trim(coalesce(p_payload->>'email','')));
    IF length(email)>254 OR (email<>'' AND email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
      OR length(coalesce(p_payload->>'name',''))>100 OR length(coalesce(p_payload->>'phone',''))>40 THEN
      RAISE EXCEPTION 'Invalid contact' USING ERRCODE='22023';
    END IF;
    UPDATE public.profiles SET emergency_contact=jsonb_build_object('name',coalesce(p_payload->>'name',''),'phone',coalesce(p_payload->>'phone',''),'email',email) WHERE id=p_subject;
    -- Changing the recipient requires fresh explicit consent.
    UPDATE public.consents SET revoked_at=now() WHERE user_id=p_subject AND consent_type::text='emergency_contact' AND revoked_at IS NULL;
    UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL WHERE user_id=p_subject AND recipient_kind='contact' AND status='pending';
    result := '{"ok":true}'::jsonb;
  ELSIF p_action='read' THEN
    SELECT jsonb_build_object('rules',(SELECT jsonb_agg(to_jsonb(r)) FROM
      (SELECT DISTINCT ON(rule_key) * FROM public.alert_rules WHERE user_id IS NULL OR user_id=p_subject ORDER BY rule_key,user_id NULLS LAST) r),
      'contact',(SELECT emergency_contact FROM public.profiles WHERE id=p_subject),
      'consents',(SELECT coalesce(jsonb_agg(consent_type::text),'[]'::jsonb) FROM public.consents WHERE user_id=p_subject AND revoked_at IS NULL)) INTO result;
  ELSE RAISE EXCEPTION 'Unknown action' USING ERRCODE='22023';
  END IF;
  IF p_action<>'read' OR NOT hms_private.is_self(p_subject) THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id)
      VALUES(auth.uid(),'alert_'||p_action,p_subject,'alerts',target);
  END IF;
  RETURN result;
END; $fn$;
CREATE FUNCTION public.hms_alert_settings(p_subject uuid,p_action text,p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $fn$ SELECT hms_private.alert_settings(p_subject,p_action,p_payload); $fn$;
REVOKE ALL ON FUNCTION hms_private.alert_settings(uuid,text,jsonb),public.hms_alert_settings(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION hms_private.alert_settings(uuid,text,jsonb),public.hms_alert_settings(uuid,text,jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
