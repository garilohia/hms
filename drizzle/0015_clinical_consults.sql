CREATE FUNCTION hms_private.clinical_summary(p_subject uuid,p_days integer DEFAULT 30,p_snapshot uuid DEFAULT NULL,p_create boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE p public.profiles; body jsonb; snapshot_id uuid; until_day date; from_day date;
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
    SELECT s.body,s.id INTO body,snapshot_id FROM public.summary_snapshots s WHERE s.id=p_snapshot AND s.user_id=p_subject;
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
    IF p_create THEN INSERT INTO public.summary_snapshots(user_id,body) VALUES(p.id,body) RETURNING id INTO snapshot_id; END IF;
  END IF;
  IF p_create OR NOT hms_private.is_self(p_subject) THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
      VALUES(auth.uid(),CASE WHEN p_create THEN 'summary_created' ELSE 'clinical_summary_read' END,p.id,'summary_snapshots',snapshot_id,
        jsonb_build_object('scope','summary_only','days',body->'days'));
  END IF;
  RETURN jsonb_build_object('id',snapshot_id,'body',body);
END;
$fn$;

CREATE FUNCTION hms_private.medications(p_subject uuid,p_items jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE items text[];
BEGIN
  PERFORM 1 FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF NOT hms_private.is_owner(p_subject) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR octet_length(p_items::text)>4096 THEN
    RAISE EXCEPTION 'Check medication list' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(trim(value)),ARRAY[]::text[]) INTO items FROM jsonb_array_elements_text(p_items);
  IF cardinality(items)>12 OR EXISTS(SELECT 1 FROM unnest(items) x WHERE x IS NULL OR length(x) NOT BETWEEN 1 AND 120)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x WHERE jsonb_typeof(x)<>'string') THEN
    RAISE EXCEPTION 'Up to 12 short medication entries' USING ERRCODE='22023'; END IF;
  UPDATE public.profiles SET medications=items WHERE id=p_subject;
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id) VALUES(auth.uid(),'reported_medications_updated',p_subject,'profiles',p_subject);
END;
$fn$;

CREATE FUNCTION hms_private.is_consult_doctor(p_subject uuid,p_doctor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
  SELECT hms_private.can_read(p_subject,'summary_only') AND EXISTS(
    SELECT 1 FROM public.doctors d JOIN public.profiles p ON p.id=d.id JOIN public.doctor_patient_links l ON l.doctor_id=d.id
    WHERE d.id=p_doctor AND p.auth_user_id=auth.uid() AND p.role='doctor' AND d.verified_at IS NOT NULL AND l.patient_id=p_subject
      AND l.status='active' AND l.revoked_at IS NULL AND l.granted_scopes && ARRAY['summary_only','full_history']::public.sharing_scope[]);
$fn$;

CREATE FUNCTION hms_private.consult_change(p_subject uuid,p_action text,p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE c public.consults; target uuid; snapshot jsonb; message_id uuid; doctor_actor boolean; scheduled timestamptz; call_link text;
BEGIN
  PERFORM 1 FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF NOT hms_private.actor_is_live() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR octet_length(p_data::text)>20000 THEN
    RAISE EXCEPTION 'Invalid consult request' USING ERRCODE='22023'; END IF;
  IF p_action='request' THEN
    IF NOT hms_private.is_owner(p_subject) THEN RAISE EXCEPTION 'Owner requests consults' USING ERRCODE='42501'; END IF;
    target:=(p_data->>'doctorId')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.doctor_patient_links l JOIN public.doctors d ON d.id=l.doctor_id JOIN public.profiles p ON p.id=d.id JOIN auth.users u ON u.id=p.auth_user_id
      WHERE l.patient_id=p_subject AND l.doctor_id=target AND l.status='active' AND l.revoked_at IS NULL AND d.verified_at IS NOT NULL AND d.available AND p.role='doctor'
        AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<now()) AND l.granted_scopes && ARRAY['summary_only','full_history']::public.sharing_scope[])
      OR NOT EXISTS(SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='doctor_sharing' AND revoked_at IS NULL)
      THEN RAISE EXCEPTION 'An available, verified linked doctor and sharing consent are required' USING ERRCODE='42501'; END IF;
    IF coalesce(p_data->>'type','') NOT IN ('urgent_review','trend_review','second_opinion','follow_up') OR length(coalesce(p_data->>'note',''))>4000
      OR (p_data->>'requestId') IS NULL THEN RAISE EXCEPTION 'Check consult type and note' USING ERRCODE='22023'; END IF;
    SELECT * INTO c FROM public.consults WHERE id=(p_data->>'requestId')::uuid;
    IF c.id IS NOT NULL THEN
      IF c.patient_id=p_subject AND c.doctor_id=target AND c.type=p_data->>'type' AND coalesce(c.patient_note,'')=trim(coalesce(p_data->>'note','')) THEN RETURN c.id; END IF;
      RAISE EXCEPTION 'Request identifier already used' USING ERRCODE='22023';
    END IF;
    snapshot:=hms_private.clinical_summary(p_subject,coalesce((p_data->>'days')::integer,30),NULL,true);
    INSERT INTO public.consults(id,patient_id,doctor_id,type,patient_note,attached_summary_id)
      VALUES((p_data->>'requestId')::uuid,p_subject,target,p_data->>'type',nullif(trim(p_data->>'note'),''),(snapshot->>'id')::uuid) RETURNING * INTO c;
  ELSE
    SELECT * INTO c FROM public.consults WHERE id=(p_data->>'consultId')::uuid AND patient_id=p_subject FOR UPDATE;
    IF c.id IS NULL THEN RAISE EXCEPTION 'Consult unavailable' USING ERRCODE='42501'; END IF;
    doctor_actor:=hms_private.is_consult_doctor(p_subject,c.doctor_id);
    IF NOT hms_private.is_owner(p_subject) AND NOT doctor_actor THEN RAISE EXCEPTION 'Consult access denied' USING ERRCODE='42501'; END IF;
    IF p_action IN ('accept','schedule') THEN
      IF NOT doctor_actor OR c.status NOT IN ('requested','accepted','scheduled') THEN RAISE EXCEPTION 'Doctor cannot schedule this consult' USING ERRCODE='42501'; END IF;
      IF p_action='accept' AND c.status IN ('accepted','scheduled') THEN RETURN c.id; END IF;
      IF p_action='schedule' THEN
        scheduled:=(p_data->>'scheduledFor')::timestamptz;
        call_link:=nullif(trim(p_data->>'callUrl'),'');
        IF scheduled IS NULL OR scheduled<now() OR scheduled>now()+interval '1 year' OR length(coalesce(call_link,''))>300
          OR (call_link IS NOT NULL AND call_link !~ '^https://(meet[.]google[.]com|([a-z0-9-]+[.])*zoom[.]us)/[^[:space:]]+$')
          THEN RAISE EXCEPTION 'Choose a future time and optional Meet or Zoom HTTPS link' USING ERRCODE='22023'; END IF;
      END IF;
      UPDATE public.consults SET status=CASE WHEN p_action='schedule' THEN 'scheduled' ELSE 'accepted' END,
        scheduled_for=CASE WHEN p_action='schedule' THEN scheduled ELSE scheduled_for END,
        call_url=CASE WHEN p_action='schedule' THEN call_link ELSE call_url END WHERE id=c.id;
    ELSIF p_action='message' THEN
      IF c.status NOT IN ('accepted','scheduled') OR length(trim(coalesce(p_data->>'body',''))) NOT BETWEEN 1 AND 4000 OR (p_data->>'messageId') IS NULL
        THEN RAISE EXCEPTION 'Chat opens after acceptance and closes with the consult' USING ERRCODE='22023'; END IF;
      message_id:=(p_data->>'messageId')::uuid;
      IF EXISTS(SELECT 1 FROM public.messages WHERE id=message_id AND (consult_id<>c.id OR sender_id<>auth.uid() OR body<>trim(p_data->>'body')))
        THEN RAISE EXCEPTION 'Message identifier already used' USING ERRCODE='22023'; END IF;
      INSERT INTO public.messages(id,consult_id,sender_id,body) VALUES(message_id,c.id,auth.uid(),trim(p_data->>'body')) ON CONFLICT(id) DO NOTHING;
    ELSIF p_action='close' THEN
      IF NOT doctor_actor OR c.status NOT IN ('accepted','scheduled') OR length(trim(coalesce(p_data->>'note',''))) NOT BETWEEN 1 AND 10000
        THEN RAISE EXCEPTION 'Doctor note required on an accepted consult' USING ERRCODE='42501'; END IF;
      UPDATE public.consults SET status='completed',completed_at=now(),doctor_note=trim(p_data->>'note') WHERE id=c.id;
    ELSIF p_action='cancel' THEN
      IF NOT hms_private.is_owner(p_subject) OR c.status NOT IN ('requested','accepted','scheduled') THEN RAISE EXCEPTION 'Cannot cancel this consult' USING ERRCODE='42501'; END IF;
      UPDATE public.consults SET status='cancelled' WHERE id=c.id;
    ELSE RAISE EXCEPTION 'Unknown consult action' USING ERRCODE='22023'; END IF;
  END IF;
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id) VALUES(auth.uid(),'consult_'||p_action,p_subject,'consults',c.id);
  RETURN c.id;
END;
$fn$;

CREATE FUNCTION hms_private.consult_read(p_id uuid,p_before jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE c public.consults; rows jsonb; next_cursor jsonb;
BEGIN
  SELECT * INTO c FROM public.consults WHERE id=p_id;
  IF c.id IS NULL OR (NOT hms_private.is_owner(c.patient_id) AND NOT hms_private.is_consult_doctor(c.patient_id,c.doctor_id)) THEN
    RAISE EXCEPTION 'Consult access denied' USING ERRCODE='42501'; END IF;
  IF octet_length(coalesce(p_before,'{}')::text)>1024 THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY sent_at DESC,id DESC),'[]') INTO rows FROM (
    SELECT id,sender_id,body,sent_at,read_at FROM public.messages WHERE consult_id=c.id
      AND (p_before IS NULL OR (sent_at,id)<((p_before->>'sent_at')::timestamptz,(p_before->>'id')::uuid)) ORDER BY sent_at DESC,id DESC LIMIT 100) x;
  IF jsonb_array_length(rows)=100 THEN next_cursor:=jsonb_build_object('sent_at',rows->99->>'sent_at','id',rows->99->>'id'); END IF;
  IF NOT hms_private.is_self(c.patient_id) THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id) VALUES(auth.uid(),'consult_read',c.patient_id,'consults',c.id);
  END IF;
  RETURN jsonb_build_object('consult',to_jsonb(c),'messages',rows,'next_cursor',next_cursor,'is_doctor',hms_private.is_consult_doctor(c.patient_id,c.doctor_id),
    'can_manage',hms_private.is_owner(c.patient_id),'patient_name',(SELECT name FROM public.profiles WHERE id=c.patient_id),
    'doctor_name',(SELECT name FROM public.profiles WHERE id=c.doctor_id),'is_sample',(SELECT is_sample FROM public.doctors WHERE id=c.doctor_id));
END;
$fn$;

CREATE FUNCTION hms_private.consult_list(p_subject uuid DEFAULT NULL,p_cursor jsonb DEFAULT NULL,p_history boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE rows jsonb; row jsonb; next_cursor jsonb;
BEGIN
  IF NOT hms_private.actor_is_live() OR (p_subject IS NOT NULL AND NOT (
    hms_private.is_owner(p_subject) OR (p_history AND hms_private.can_read(p_subject,'full_history'))))
    THEN RAISE EXCEPTION 'Consult list unavailable' USING ERRCODE='42501'; END IF;
  IF p_subject IS NULL AND (p_history OR NOT EXISTS(SELECT 1 FROM public.profiles p JOIN public.doctors d ON d.id=p.id
    WHERE p.auth_user_id=auth.uid() AND p.role='doctor' AND d.verified_at IS NOT NULL)) THEN RAISE EXCEPTION 'Doctor queue unavailable' USING ERRCODE='42501'; END IF;
  IF octet_length(coalesce(p_cursor,'{}')::text)>1024 THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY requested_at DESC,id DESC),'[]') INTO rows FROM (
    SELECT c.id,c.patient_id,c.doctor_id,c.type,c.status,c.requested_at,c.scheduled_for,c.completed_at,
      CASE WHEN p_history THEN c.doctor_note ELSE NULL END doctor_note,
      p.name patient_name,dp.name doctor_name,d.is_sample
    FROM public.consults c JOIN public.profiles p ON p.id=c.patient_id JOIN public.profiles dp ON dp.id=c.doctor_id JOIN public.doctors d ON d.id=c.doctor_id
    WHERE ((p_subject IS NOT NULL AND c.patient_id=p_subject) OR (p_subject IS NULL AND hms_private.is_consult_doctor(c.patient_id,c.doctor_id)))
      AND (NOT p_history OR c.status='completed')
      AND (p_cursor IS NULL OR (c.requested_at,c.id)<((p_cursor->>'requested_at')::timestamptz,(p_cursor->>'id')::uuid))
    ORDER BY c.requested_at DESC,c.id DESC LIMIT 100) x;
  FOR row IN SELECT value FROM jsonb_array_elements(rows) LOOP
    IF NOT hms_private.is_self((row->>'patient_id')::uuid) THEN
      INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
        VALUES(auth.uid(),'consult_list_read',(row->>'patient_id')::uuid,'consults',(row->>'id')::uuid,jsonb_build_object('history',p_history));
    END IF;
  END LOOP;
  IF jsonb_array_length(rows)=100 THEN next_cursor:=jsonb_build_object('requested_at',rows->99->>'requested_at','id',rows->99->>'id'); END IF;
  RETURN jsonb_build_object('rows',rows,'next_cursor',next_cursor);
END;
$fn$;

CREATE FUNCTION public.hms_clinical_summary(p_subject uuid,p_days integer DEFAULT 30,p_snapshot uuid DEFAULT NULL,p_create boolean DEFAULT false) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.clinical_summary(p_subject,p_days,p_snapshot,p_create); $fn$;
CREATE FUNCTION public.hms_medications(p_subject uuid,p_items jsonb) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.medications(p_subject,p_items); $fn$;
CREATE FUNCTION public.hms_consult_change(p_subject uuid,p_action text,p_data jsonb) RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.consult_change(p_subject,p_action,p_data); $fn$;
CREATE FUNCTION public.hms_consult_read(p_id uuid,p_before jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.consult_read(p_id,p_before); $fn$;
CREATE FUNCTION public.hms_consult_list(p_subject uuid DEFAULT NULL,p_cursor jsonb DEFAULT NULL,p_history boolean DEFAULT false) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.consult_list(p_subject,p_cursor,p_history); $fn$;
REVOKE ALL ON FUNCTION hms_private.clinical_summary(uuid,integer,uuid,boolean),hms_private.medications(uuid,jsonb),hms_private.is_consult_doctor(uuid,uuid),hms_private.consult_change(uuid,text,jsonb),hms_private.consult_read(uuid,jsonb),hms_private.consult_list(uuid,jsonb,boolean),
  public.hms_clinical_summary(uuid,integer,uuid,boolean),public.hms_medications(uuid,jsonb),public.hms_consult_change(uuid,text,jsonb),public.hms_consult_read(uuid,jsonb),public.hms_consult_list(uuid,jsonb,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION hms_private.clinical_summary(uuid,integer,uuid,boolean),hms_private.medications(uuid,jsonb),hms_private.is_consult_doctor(uuid,uuid),hms_private.consult_change(uuid,text,jsonb),hms_private.consult_read(uuid,jsonb),hms_private.consult_list(uuid,jsonb,boolean),
  public.hms_clinical_summary(uuid,integer,uuid,boolean),public.hms_medications(uuid,jsonb),public.hms_consult_change(uuid,text,jsonb),public.hms_consult_read(uuid,jsonb),public.hms_consult_list(uuid,jsonb,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';
