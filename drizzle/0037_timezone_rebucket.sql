-- OQ005: post-import timezone changes. Raw readings are absolute instants, so only
-- derived day-keyed rows move. Changing the zone re-enqueues every affected local day
-- through the existing durable summary queue instead of refusing the change.
ALTER TABLE "profiles" ADD COLUMN "previous_timezone" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "timezone_changed_at" timestamptz;--> statement-breakpoint
ALTER TABLE "summary_jobs" ADD COLUMN "rebucket" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "summary_snapshots" ADD COLUMN "timezone" text;--> statement-breakpoint
UPDATE "summary_snapshots" s SET "timezone"=p."timezone" FROM "profiles" p WHERE p.id=s.user_id AND s."timezone" IS NULL;--> statement-breakpoint

-- Enqueue every local day spanned by this profile's readings. A two-day margin covers
-- the widest possible offset difference (-12:00 to +14:00 is more than one calendar day),
-- so days that existed only under the old zone are recomputed and emptied too.
CREATE OR REPLACE FUNCTION hms_private.enqueue_rebucket(p_subject uuid,p_zone text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE first_at timestamptz; last_at timestamptz; first_day date; last_day date; queued integer;
BEGIN
  SELECT min(recorded_at),max(recorded_at) INTO first_at,last_at FROM public.metrics WHERE user_id=p_subject;
  IF first_at IS NULL THEN RETURN 0; END IF;
  first_day := ((first_at AT TIME ZONE p_zone)::date)-2;
  last_day := ((last_at AT TIME ZONE p_zone)::date)+2;
  INSERT INTO public.summary_jobs(user_id,day,rebucket)
    SELECT p_subject,d::date,true FROM generate_series(first_day,last_day,interval '1 day') d
    ON CONFLICT(user_id,day) DO UPDATE
      SET revision=public.summary_jobs.revision+1,rebucket=true,available_at=now(),locked_until=null,lease_token=null,attempts=0,last_error=null;
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN queued;
END; $fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION hms_private.change_timezone(p_subject uuid,p_zone text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE p public.profiles; queued integer;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id=p_subject;
  IF p.timezone=p_zone THEN RETURN 0; END IF;
  queued := hms_private.enqueue_rebucket(p_subject,p_zone);
  UPDATE public.profiles SET timezone=p_zone,
    previous_timezone=CASE WHEN queued>0 THEN p.timezone ELSE previous_timezone END,
    timezone_changed_at=CASE WHEN queued>0 THEN now() ELSE timezone_changed_at END
    WHERE id=p_subject;
  IF queued>0 THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,metadata)
      VALUES(auth.uid(),'profile_timezone_rebucket',p_subject,'summary_jobs',
        jsonb_build_object('from',p.timezone,'to',p_zone,'days_queued',queued));
  END IF;
  RETURN queued;
END; $fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION hms_private.profile_settings(p_subject uuid,p_action text,p_payload jsonb) RETURNS void
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
    UPDATE public.profiles SET name=trim(p_payload->>'name'),dob=birth,sex_at_birth=p_payload->>'sex',country_of_residence=country,
      local_emergency_number=CASE country WHEN 'IN' THEN '112' WHEN 'US' THEN '911' WHEN 'GB' THEN '999' WHEN 'AE' THEN '998' ELSE 'your local emergency number' END WHERE id=p_subject;
    PERFORM hms_private.change_timezone(p_subject,tz);
  ELSIF p_action='timezone' THEN
    -- OQ005: history is re-bucketed rather than refused. Each affected day is labelled
    -- as awaiting recalculation until its queued job runs.
    tz := p_payload->>'timezone';
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=tz) THEN
      RAISE EXCEPTION 'Choose a valid timezone' USING ERRCODE='22023'; END IF;
    PERFORM hms_private.change_timezone(p_subject,tz);
  ELSIF p_action='complete' THEN
    IF p.sex_at_birth IS NULL OR p_payload->>'disclaimer'<>'true' OR p_payload->>'disclaimer' IS NULL THEN RAISE EXCEPTION 'Read and accept the disclaimer first' USING ERRCODE='22023'; END IF;
    UPDATE public.profiles SET onboarding_completed_at=coalesce(onboarding_completed_at,now()) WHERE id=p_subject;
  ELSIF p_action='cycle' THEN
    IF jsonb_typeof(p_payload->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Choose whether to show cycle estimates' USING ERRCODE='22023'; END IF;
    UPDATE public.profiles SET cycle_tracking_enabled=(p_payload->>'enabled')::boolean WHERE id=p_subject;
  ELSIF p_action='display' THEN
    -- DESIGN.md §9: the density is chosen at onboarding, changed under More, stored per profile and never auto-detected.
    IF coalesce(p_payload->>'mode','') NOT IN ('simple','standard','advanced') THEN RAISE EXCEPTION 'Choose Simple, Standard or Advanced' USING ERRCODE='22023'; END IF;
    UPDATE public.profiles SET display_mode=p_payload->>'mode' WHERE id=p_subject;
  ELSIF p_action='period' THEN
    IF NOT p.cycle_tracking_enabled OR NOT EXISTS(SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='data_ingestion' AND revoked_at IS NULL)
    THEN RAISE EXCEPTION 'Enable cycle tracking and ingestion consent first' USING ERRCODE='42501'; END IF;
    start_day := (p_payload->>'start')::date; end_day := nullif(p_payload->>'end','')::date;
    IF start_day IS NULL OR start_day>current_date OR start_day<p.dob OR (end_day IS NOT NULL AND (end_day<start_day OR end_day>current_date OR end_day>start_day+30))
    THEN RAISE EXCEPTION 'Check period dates' USING ERRCODE='22023'; END IF;
    INSERT INTO public.cycle_logs(user_id,day,period_start,period_end,phase,is_inferred,confidence,origin)
      VALUES(p_subject,start_day,start_day,end_day,'menstrual',false,'high','manual') ON CONFLICT(user_id,day) DO UPDATE
      SET period_start=excluded.period_start,period_end=excluded.period_end,origin='manual',is_inferred=false,confidence='high',phase='menstrual';
    INSERT INTO public.summary_jobs(user_id,day) SELECT p_subject,day FROM public.daily_summaries WHERE user_id=p_subject AND day>=start_day
      ON CONFLICT(user_id,day) DO UPDATE SET revision=public.summary_jobs.revision+1,available_at=now();
  ELSE RAISE EXCEPTION 'Invalid settings action' USING ERRCODE='22023'; END IF;
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,metadata)
    VALUES(auth.uid(),'profile_'||p_action,p_subject,'profiles',jsonb_build_object('authority',CASE WHEN p.kind='dependent' THEN 'guardian' ELSE 'self' END));
END; $fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION hms_private.enqueue_rebucket(uuid,text),hms_private.change_timezone(uuid,text) FROM PUBLIC,anon,authenticated;
