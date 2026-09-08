-- Scoped, paginated reads. No client gets direct write privileges.
CREATE FUNCTION hms_private.can_read(p_subject uuid, p_scope text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT hms_private.actor_is_live() AND p_scope IN ('summary_only','full_history','alerts') AND (
    hms_private.is_owner(p_subject) OR (
      EXISTS (SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='doctor_sharing' AND revoked_at IS NULL)
      AND (EXISTS (
        SELECT 1 FROM public.doctor_patient_links l JOIN public.doctors d ON d.id=l.doctor_id JOIN public.profiles p ON p.id=d.id
        WHERE l.patient_id=p_subject AND p.auth_user_id=auth.uid() AND p.role='doctor' AND d.verified_at IS NOT NULL
          AND l.status='active' AND l.revoked_at IS NULL
          AND (p_scope::public.sharing_scope=ANY(l.granted_scopes) OR (p_scope='summary_only' AND 'full_history'=ANY(l.granted_scopes)))
      ) OR EXISTS (
        SELECT 1 FROM public.caregiver_links l WHERE l.patient_id=p_subject AND l.caregiver_id=auth.uid() AND l.role='caregiver'
          AND l.status='active' AND l.revoked_at IS NULL
          AND (p_scope::public.sharing_scope=ANY(l.granted_scopes) OR (p_scope='summary_only' AND 'full_history'=ANY(l.granted_scopes)))
      ))
    )
  );
$fn$;

CREATE FUNCTION hms_private.patient_view(p_subject uuid, p_section text, p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_cursor jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE p public.profiles; result jsonb; rows jsonb; scope text; manages boolean; first_day date; last_day date;
BEGIN
  IF p_section IS NULL OR p_section NOT IN ('today','history','raw','alerts','advanced','sources','documents')
    OR octet_length(coalesce(p_cursor,'{}')::text)>1024 OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from>p_to)
  THEN RAISE EXCEPTION 'Invalid view request' USING ERRCODE='22023'; END IF;
  scope := CASE WHEN p_section='alerts' THEN 'alerts' WHEN p_section IN ('history','raw','advanced','documents','sources') THEN 'full_history' ELSE 'summary_only' END;
  IF NOT hms_private.can_read(p_subject,scope) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO p FROM public.profiles WHERE id=p_subject;
  manages := hms_private.is_owner(p_subject);
  IF NOT hms_private.is_self(p_subject) THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
    VALUES(auth.uid(),CASE WHEN manages THEN 'guardian_read' ELSE 'shared_read' END,p_subject,'patient_view',p_subject,
      jsonb_build_object('section',p_section,'scope',scope,'from',p_from,'to',p_to));
  END IF;
  result := jsonb_build_object('profile',jsonb_build_object('id',p.id,'name',p.name,'dob',p.dob,'sex_at_birth',p.sex_at_birth,
    'kind',p.kind,'timezone',p.timezone,'country_of_residence',p.country_of_residence,'cycle_tracking_enabled',p.cycle_tracking_enabled,
    'onboarding_completed_at',p.onboarding_completed_at),'can_manage',manages,
    'can_read_alerts',hms_private.can_read(p_subject,'alerts'),'can_read_history',hms_private.can_read(p_subject,'full_history'),
    'consent_given_by_guardian',EXISTS(SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='doctor_sharing' AND authority='guardian' AND revoked_at IS NULL));
  IF p_section='today' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO rows FROM (SELECT * FROM public.daily_summaries WHERE user_id=p_subject ORDER BY day DESC LIMIT 1) s;
    result := result || jsonb_build_object('summaries',rows,'contains_sample',EXISTS(SELECT 1 FROM public.data_sources WHERE user_id=p_subject AND provider='simulator'),
      'insights',(SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]') FROM (SELECT * FROM public.insights WHERE user_id=p_subject AND resolved_at IS NULL AND dismissed_at IS NULL
        AND (category<>'cycle' OR p.cycle_tracking_enabled) ORDER BY created_at DESC,id LIMIT 3) i));
    IF hms_private.can_read(p_subject,'alerts') THEN
      result := result || jsonb_build_object('alerts',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') FROM
        (SELECT * FROM public.alerts WHERE user_id=p_subject AND acknowledged_at IS NULL AND (NOT is_historical OR is_sample)
          ORDER BY CASE severity WHEN 'urgent' THEN 0 WHEN 'attention' THEN 1 ELSE 2 END,fired_at DESC,id LIMIT 1) a),
        'active_alert_count',(SELECT count(*) FROM public.alerts WHERE user_id=p_subject AND acknowledged_at IS NULL AND (NOT is_historical OR is_sample)));
    END IF;
    IF manages THEN result := result || jsonb_build_object('pending_jobs',(SELECT count(*) FROM public.summary_jobs WHERE user_id=p_subject AND revision>processed_revision),
      'ingestion_consent',EXISTS(SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='data_ingestion' AND revoked_at IS NULL)); END IF;
  ELSIF p_section='history' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.day DESC),'[]'),min(s.day),max(s.day) INTO rows,first_day,last_day FROM
      (SELECT * FROM public.daily_summaries WHERE user_id=p_subject AND (p_from IS NULL OR day>=p_from) AND (p_to IS NULL OR day<=p_to)
        AND (p_cursor->>'day' IS NULL OR day<(p_cursor->>'day')::date) ORDER BY day DESC LIMIT 365) s;
    result := result || jsonb_build_object('summaries',rows,'next_cursor',CASE WHEN EXISTS(SELECT 1 FROM public.daily_summaries WHERE user_id=p_subject AND day<first_day AND (p_from IS NULL OR day>=p_from)) THEN jsonb_build_object('day',first_day) END,
      'cycles',CASE WHEN p.cycle_tracking_enabled THEN (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY day),'[]') FROM public.cycle_logs c WHERE user_id=p_subject AND day BETWEEN first_day AND last_day) ELSE '[]'::jsonb END);
    IF hms_private.can_read(p_subject,'alerts') THEN
      result := result || jsonb_build_object('markers',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') FROM
        (SELECT (coalesce(event_start,fired_at) AT TIME ZONE p.timezone)::date AS day,count(*) AS count,bool_or(acknowledged_at IS NOT NULL) AS acknowledged
          FROM public.alerts WHERE user_id=p_subject AND (coalesce(event_start,fired_at) AT TIME ZONE p.timezone)::date BETWEEN first_day AND last_day GROUP BY 1) a));
    END IF;
  ELSIF p_section='raw' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY recorded_at DESC,id DESC),'[]') INTO rows FROM
      (SELECT m.*,s.provider,s.metadata FROM public.metrics m JOIN public.data_sources s ON s.id=m.source_id WHERE m.user_id=p_subject
        AND (p_from IS NULL OR m.recorded_at >= p_from::timestamp AT TIME ZONE p.timezone)
        AND (p_to IS NULL OR m.recorded_at < (p_to+1)::timestamp AT TIME ZONE p.timezone)
        AND (p_cursor->>'at' IS NULL OR (m.recorded_at,m.id)<((p_cursor->>'at')::timestamptz,(p_cursor->>'id')::uuid)) ORDER BY m.recorded_at DESC,m.id DESC LIMIT 200) m;
    result := result || jsonb_build_object('metrics',rows,'next_cursor',CASE WHEN jsonb_array_length(rows)=200 THEN jsonb_build_object('at',rows->199->>'recorded_at','id',rows->199->>'id') END);
  ELSIF p_section='alerts' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY fired_at DESC,id DESC),'[]') INTO rows FROM
      (SELECT * FROM public.alerts WHERE user_id=p_subject
        AND (p_from IS NULL OR coalesce(event_start,fired_at) >= p_from::timestamp AT TIME ZONE p.timezone)
        AND (p_to IS NULL OR coalesce(event_start,fired_at) < (p_to+1)::timestamp AT TIME ZONE p.timezone)
        AND (p_cursor->>'at' IS NULL OR (fired_at,id)<((p_cursor->>'at')::timestamptz,(p_cursor->>'id')::uuid)) ORDER BY fired_at DESC,id DESC LIMIT 100) a;
    result := result || jsonb_build_object('alerts',rows,'next_cursor',CASE WHEN jsonb_array_length(rows)=100 THEN jsonb_build_object('at',rows->99->>'fired_at','id',rows->99->>'id') END);
  ELSIF p_section='advanced' THEN
    result := result || jsonb_build_object('baselines',(SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]') FROM public.baselines b WHERE user_id=p_subject));
  ELSIF p_section='sources' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') INTO rows FROM (SELECT * FROM public.data_sources WHERE user_id=p_subject
      AND (p_cursor->>'id' IS NULL OR id>(p_cursor->>'id')::uuid) ORDER BY id LIMIT 200) s;
    result := result || jsonb_build_object('sources',rows,'next_cursor',CASE WHEN jsonb_array_length(rows)=200 THEN jsonb_build_object('id',rows->199->>'id') END);
  ELSE
    SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]') INTO rows FROM (SELECT id,type,title,tags,uploaded_at FROM public.documents WHERE user_id=p_subject
      AND (p_cursor->>'id' IS NULL OR id>(p_cursor->>'id')::uuid) ORDER BY id LIMIT 100) d;
    result := result || jsonb_build_object('documents',rows,'next_cursor',CASE WHEN jsonb_array_length(rows)=100 THEN jsonb_build_object('id',rows->99->>'id') END);
  END IF;
  RETURN result;
END; $fn$;

CREATE FUNCTION hms_private.profile_settings(p_subject uuid,p_action text,p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE p public.profiles; birth date; tz text; country text; start_day date; end_day date;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF NOT hms_private.is_owner(p_subject) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
  IF p_action IS NULL OR octet_length(coalesce(p_payload,'{}')::text)>4096 THEN RAISE EXCEPTION 'Invalid settings' USING ERRCODE='22023'; END IF;
  IF p_action='identity' THEN
    birth := (p_payload->>'dob')::date; tz := p_payload->>'timezone'; country := upper(p_payload->>'country');
    IF birth IS NULL OR birth>current_date OR birth<(current_date-interval '120 years')::date
      OR (p.kind='self' AND birth>(current_date-interval '18 years')::date)
      OR length(trim(coalesce(p_payload->>'name',''))) NOT BETWEEN 1 AND 120
      OR coalesce(p_payload->>'sex','') NOT IN ('female','male','intersex','prefer_not_to_say')
      OR coalesce(country,'') !~ '^[A-Z]{2}$' OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=tz)
    THEN RAISE EXCEPTION 'Check name, adult date of birth, sex, country and timezone' USING ERRCODE='22023'; END IF;
    IF tz<>p.timezone AND EXISTS(SELECT 1 FROM public.metrics WHERE user_id=p_subject) THEN
      RAISE EXCEPTION 'Timezone cannot change after an import in this version' USING ERRCODE='22023'; END IF;
    UPDATE public.profiles SET name=trim(p_payload->>'name'),dob=birth,sex_at_birth=p_payload->>'sex',country_of_residence=country,timezone=tz,
      local_emergency_number=CASE country WHEN 'IN' THEN '112' WHEN 'US' THEN '911' WHEN 'GB' THEN '999' WHEN 'AE' THEN '998' ELSE 'your local emergency number' END WHERE id=p_subject;
  ELSIF p_action='complete' THEN
    IF p.sex_at_birth IS NULL OR p_payload->>'disclaimer'<>'true' OR p_payload->>'disclaimer' IS NULL THEN RAISE EXCEPTION 'Read and accept the disclaimer first' USING ERRCODE='22023'; END IF;
    UPDATE public.profiles SET onboarding_completed_at=coalesce(onboarding_completed_at,now()) WHERE id=p_subject;
  ELSIF p_action='cycle' THEN
    IF jsonb_typeof(p_payload->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Choose whether to show cycle estimates' USING ERRCODE='22023'; END IF;
    UPDATE public.profiles SET cycle_tracking_enabled=(p_payload->>'enabled')::boolean WHERE id=p_subject;
  ELSIF p_action='period' THEN
    IF NOT p.cycle_tracking_enabled OR NOT EXISTS(SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='data_ingestion' AND revoked_at IS NULL)
    THEN RAISE EXCEPTION 'Enable cycle tracking and ingestion consent first' USING ERRCODE='42501'; END IF;
    start_day := (p_payload->>'start')::date; end_day := nullif(p_payload->>'end','')::date;
    IF start_day IS NULL OR start_day>current_date OR start_day<p.dob OR (end_day IS NOT NULL AND (end_day<start_day OR end_day>current_date OR end_day>start_day+30))
    THEN RAISE EXCEPTION 'Check period dates' USING ERRCODE='22023'; END IF;
    INSERT INTO public.cycle_logs(user_id,day,period_start,period_end,phase,is_inferred,confidence,origin)
      VALUES(p_subject,start_day,start_day,end_day,'menstrual',false,'high','manual') ON CONFLICT(user_id,day) DO UPDATE
      SET period_start=excluded.period_start,period_end=excluded.period_end,origin='manual',is_inferred=false,confidence='high',phase='menstrual';
    -- Re-evaluate phase-dependent insights even when this anchor has no raw row.
    INSERT INTO public.summary_jobs(user_id,day) SELECT p_subject,day FROM public.daily_summaries WHERE user_id=p_subject AND day>=start_day
      ON CONFLICT(user_id,day) DO UPDATE SET revision=public.summary_jobs.revision+1,available_at=now();
  ELSE RAISE EXCEPTION 'Invalid settings action' USING ERRCODE='22023'; END IF;
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,metadata)
    VALUES(auth.uid(),'profile_'||p_action,p_subject,'profiles',jsonb_build_object('authority',CASE WHEN p.kind='dependent' THEN 'guardian' ELSE 'self' END));
END; $fn$;

CREATE FUNCTION public.hms_patient_view(p_subject uuid,p_section text,p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_cursor jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $fn$ SELECT hms_private.patient_view(p_subject,p_section,p_from,p_to,p_cursor); $fn$;
CREATE FUNCTION public.hms_profile_settings(p_subject uuid,p_action text,p_payload jsonb)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $fn$ SELECT hms_private.profile_settings(p_subject,p_action,p_payload); $fn$;
REVOKE ALL ON FUNCTION hms_private.can_read(uuid,text),hms_private.patient_view(uuid,text,date,date,jsonb),hms_private.profile_settings(uuid,text,jsonb),
  public.hms_patient_view(uuid,text,date,date,jsonb),public.hms_profile_settings(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION hms_private.can_read(uuid,text),hms_private.patient_view(uuid,text,date,date,jsonb),hms_private.profile_settings(uuid,text,jsonb),
  public.hms_patient_view(uuid,text,date,date,jsonb),public.hms_profile_settings(uuid,text,jsonb) TO authenticated;
