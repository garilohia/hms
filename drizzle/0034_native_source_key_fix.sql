CREATE OR REPLACE FUNCTION hms_private.connect_native_source(
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
$fn$;
