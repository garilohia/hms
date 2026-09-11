-- OQ005: snapshots are immutable. Record the timezone each was computed in and flag a
-- doctor's copy when the patient has since changed zone, so a stale snapshot is never
-- read as current.
CREATE OR REPLACE FUNCTION hms_private.clinical_summary(p_subject uuid,p_days integer DEFAULT 30,p_snapshot uuid DEFAULT NULL,p_create boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE p public.profiles; body jsonb; snapshot_id uuid; until_day date; from_day date; snapshot_zone text;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id=p_subject FOR SHARE;
  IF NOT hms_private.can_read(p_subject,'summary_only') OR (NOT hms_private.is_owner(p_subject) AND NOT EXISTS(
    SELECT 1 FROM public.profiles dp JOIN public.doctors d ON d.id=dp.id JOIN public.doctor_patient_links l ON l.doctor_id=d.id
    WHERE dp.auth_user_id=auth.uid() AND dp.role='doctor' AND d.verified_at IS NOT NULL AND l.patient_id=p_subject
      AND l.status='active' AND l.revoked_at IS NULL AND l.granted_scopes && ARRAY['summary_only','full_history']::public.sharing_scope[]
  )) THEN RAISE EXCEPTION 'Clinical summary access denied' USING ERRCODE='42501'; END IF;
  IF p_days IS NULL OR p_days NOT IN (30,90) OR p_create IS NULL OR (p_create AND p_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'Choose a 30 or 90 day summary' USING ERRCODE='22023'; END IF;
  IF p_create AND NOT hms_private.is_owner(p_subject) THEN RAISE EXCEPTION 'Owner creates snapshots' USING ERRCODE='42501'; END IF;
  IF p_snapshot IS NOT NULL THEN
    SELECT s.body,s.id,coalesce(s.timezone,s.body->'profile'->>'timezone') INTO body,snapshot_id,snapshot_zone
      FROM public.summary_snapshots s WHERE s.id=p_snapshot AND s.user_id=p_subject;
    IF body IS NULL THEN RAISE EXCEPTION 'Snapshot unavailable' USING ERRCODE='42501'; END IF;
  ELSE
    until_day:=(now() AT TIME ZONE p.timezone)::date; from_day:=until_day-p_days+1;
    body:=jsonb_build_object('version',1,'generated_at',now(),'from',from_day,'to',until_day,'days',p_days,
      'profile',jsonb_build_object('id',p.id,'name',p.name,'dob',p.dob,'sex_at_birth',p.sex_at_birth,'timezone',p.timezone,'country',p.country_of_residence),
      'consent_given_by_guardian',EXISTS(SELECT 1 FROM public.consents WHERE user_id=p.id AND authority='guardian' AND consent_type IN ('doctor_sharing','data_ingestion') AND revoked_at IS NULL),
      'contains_sample',EXISTS(SELECT 1 FROM public.data_sources WHERE user_id=p.id AND provider='simulator'),
      'medications',p.medications,
      'series',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY day),'[]') FROM (
        SELECT day,rhr,hrv_avg,spo2_avg,spo2_min,sleep_duration_min,weight_kg,bp_systolic,bp_diastolic,contains_sample
        FROM public.daily_summaries WHERE user_id=p.id AND day BETWEEN from_day AND until_day ORDER BY day LIMIT 90) x),
      'alert_counts',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (
        SELECT severity,count(*)::integer AS count FROM public.alerts WHERE user_id=p.id
          AND (coalesce(event_start,fired_at) AT TIME ZONE p.timezone)::date BETWEEN from_day AND until_day GROUP BY severity) x),
      'documents',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY uploaded_at DESC,id),'[]') FROM (
        SELECT id,type,title,uploaded_at FROM public.documents WHERE user_id=p.id ORDER BY uploaded_at DESC,id LIMIT 8) x),
      'document_count',(SELECT count(*) FROM public.documents WHERE user_id=p.id),
      'disclaimer','Generated from consumer wearable data; not a medical device.');
    snapshot_zone:=p.timezone;
    IF p_create THEN INSERT INTO public.summary_snapshots(user_id,body,timezone) VALUES(p.id,body,p.timezone) RETURNING id INTO snapshot_id; END IF;
  END IF;
  IF p_create OR NOT hms_private.is_self(p_subject) THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
      VALUES(auth.uid(),CASE WHEN p_create THEN 'summary_created' ELSE 'clinical_summary_read' END,p.id,'summary_snapshots',snapshot_id,
        jsonb_build_object('scope','summary_only','days',body->'days'));
  END IF;
  -- OQ005: a shared snapshot stays exactly as it was shared. If the patient has since
  -- changed home timezone, its days no longer match their live history, so say so.
  RETURN jsonb_build_object('id',snapshot_id,'body',body,'timezone',snapshot_zone,
    'timezone_changed',snapshot_zone IS NOT NULL AND snapshot_zone<>p.timezone);
END;
$fn$;
