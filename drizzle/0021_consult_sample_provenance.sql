ALTER TABLE "consults" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;

UPDATE public.consults c SET is_sample=d.is_sample FROM public.doctors d WHERE d.id=c.doctor_id;
CREATE FUNCTION hms_private.consult_sample_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  NEW.is_sample:=NEW.is_sample OR coalesce((SELECT is_sample FROM public.doctors WHERE id=NEW.doctor_id),false);
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION hms_private.consult_sample_provenance() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER hms_consult_sample BEFORE INSERT OR UPDATE OF doctor_id ON public.consults
FOR EACH ROW EXECUTE FUNCTION hms_private.consult_sample_provenance();

CREATE OR REPLACE FUNCTION hms_private.consult_read(p_id uuid,p_before jsonb DEFAULT NULL) RETURNS jsonb
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
    'doctor_name',coalesce((SELECT name FROM public.profiles WHERE id=c.doctor_id),'Former doctor'),'is_sample',c.is_sample);
END;
$fn$;

CREATE OR REPLACE FUNCTION hms_private.consult_list(p_subject uuid DEFAULT NULL,p_cursor jsonb DEFAULT NULL,p_history boolean DEFAULT false) RETURNS jsonb
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
      p.name patient_name,coalesce(dp.name,'Former doctor') doctor_name,c.is_sample
    FROM public.consults c JOIN public.profiles p ON p.id=c.patient_id LEFT JOIN public.profiles dp ON dp.id=c.doctor_id
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
NOTIFY pgrst,'reload schema';
