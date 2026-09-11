-- OQ005: surface re-bucket progress and per-day staleness. Raw readings never move; only
-- derived day-keyed rows do, so history stays readable and each pending day is labelled.
CREATE OR REPLACE FUNCTION hms_private.patient_view(p_subject uuid, p_section text, p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_cursor jsonb DEFAULT NULL)
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
    'kind',p.kind,'timezone',p.timezone,'country_of_residence',p.country_of_residence,'cycle_tracking_enabled',p.cycle_tracking_enabled,'display_mode',p.display_mode,
    'onboarding_completed_at',p.onboarding_completed_at),'can_manage',manages,
    'can_read_alerts',hms_private.can_read(p_subject,'alerts'),'can_read_history',hms_private.can_read(p_subject,'full_history'),
    'consent_given_by_guardian',EXISTS(SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='doctor_sharing' AND authority='guardian' AND revoked_at IS NULL),
    'rebucket',(SELECT CASE WHEN count(*)>0 THEN jsonb_build_object('from',p.previous_timezone,'to',p.timezone,'changed_at',p.timezone_changed_at,'pending',count(*)) END
      FROM public.summary_jobs WHERE user_id=p_subject AND rebucket AND revision>processed_revision));
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
      'cycles',CASE WHEN p.cycle_tracking_enabled THEN (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY day),'[]') FROM public.cycle_logs c WHERE user_id=p_subject AND day BETWEEN first_day AND last_day) ELSE '[]'::jsonb END,
      -- OQ005: days still queued for recalculation are labelled rather than hidden.
      'stale_days',(SELECT coalesce(jsonb_agg(day ORDER BY day),'[]') FROM public.summary_jobs
        WHERE user_id=p_subject AND revision>processed_revision AND day BETWEEN first_day AND last_day));
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
