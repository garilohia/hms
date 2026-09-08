-- Explicit care-team commands. Clients retain SELECT-only direct table grants.
CREATE FUNCTION hms_private.care_change(p_subject uuid, p_action text, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE partner uuid; scopes public.sharing_scope[]; link_id uuid; link public.caregiver_links;
BEGIN
  IF NOT hms_private.actor_is_live() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR octet_length(p_data::text)>4096 THEN
    RAISE EXCEPTION 'Invalid sharing request' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF p_action='accept_caregiver' THEN
    SELECT * INTO link FROM public.caregiver_links WHERE id=(p_data->>'linkId')::uuid AND patient_id=p_subject FOR UPDATE;
    IF link.id IS NULL OR link.caregiver_id<>auth.uid() OR link.role<>'caregiver' OR link.status<>'invited' OR link.revoked_at IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=auth.uid() AND email_confirmed_at IS NOT NULL)
    THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
    UPDATE public.caregiver_links SET status='active' WHERE id=link.id;
    link_id:=link.id;
  ELSE
    IF NOT hms_private.is_owner(p_subject) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
    IF p_action IN ('link_doctor','invite_caregiver') THEN
      IF NOT EXISTS(SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='doctor_sharing' AND revoked_at IS NULL)
        THEN RAISE EXCEPTION 'Sharing consent required' USING ERRCODE='42501'; END IF;
      partner:=(p_data->>'partnerId')::uuid;
      IF partner IS NULL OR jsonb_typeof(p_data->'scopes') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Choose recipient and scopes' USING ERRCODE='22023'; END IF;
      SELECT array_agg(DISTINCT value::public.sharing_scope) INTO scopes FROM jsonb_array_elements_text(p_data->'scopes');
      IF cardinality(scopes) NOT BETWEEN 1 AND 3 OR scopes IS NULL OR NOT(scopes && ARRAY['summary_only','full_history']::public.sharing_scope[])
        THEN RAISE EXCEPTION 'Choose summary or full history' USING ERRCODE='22023'; END IF;
      IF p_action='link_doctor' THEN
        IF partner=p_subject OR NOT EXISTS(SELECT 1 FROM public.doctors d JOIN public.profiles p ON p.id=d.id JOIN auth.users u ON u.id=p.auth_user_id
          WHERE d.id=partner AND p.role='doctor' AND d.verified_at IS NOT NULL AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<now()))
          THEN RAISE EXCEPTION 'Verified doctor unavailable' USING ERRCODE='42501'; END IF;
        INSERT INTO public.doctor_patient_links(doctor_id,patient_id,status,granted_scopes)
          VALUES(partner,p_subject,'active',scopes) ON CONFLICT(doctor_id,patient_id) DO UPDATE SET status='active',granted_scopes=excluded.granted_scopes,revoked_at=NULL
          RETURNING id INTO link_id;
      ELSE
        IF partner=auth.uid() OR NOT EXISTS(SELECT 1 FROM public.profiles p JOIN auth.users u ON u.id=p.auth_user_id WHERE p.auth_user_id=partner
          AND p.kind='self' AND p.dob<=(current_date-interval '18 years')::date AND u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<now()))
          THEN RAISE EXCEPTION 'Confirmed adult account required' USING ERRCODE='42501'; END IF;
        IF EXISTS(SELECT 1 FROM public.caregiver_links WHERE patient_id=p_subject AND caregiver_id=partner AND role='guardian')
          THEN RAISE EXCEPTION 'Guardian authority cannot be changed here' USING ERRCODE='42501'; END IF;
        INSERT INTO public.caregiver_links(patient_id,caregiver_id,role,status,granted_scopes,invited_by)
          VALUES(p_subject,partner,'caregiver','invited',scopes,'patient') ON CONFLICT(patient_id,caregiver_id) DO UPDATE
          SET status='invited',granted_scopes=excluded.granted_scopes,revoked_at=NULL,created_at=now() RETURNING id INTO link_id;
      END IF;
    ELSIF p_action='revoke_doctor' THEN
      UPDATE public.doctor_patient_links SET status='revoked',revoked_at=now()
        WHERE id=(p_data->>'linkId')::uuid AND patient_id=p_subject RETURNING id,doctor_id INTO link_id,partner;
      UPDATE public.consults SET status='cancelled' WHERE patient_id=p_subject AND doctor_id=partner AND status IN ('requested','accepted','scheduled');
    ELSIF p_action='revoke_caregiver' THEN
      UPDATE public.caregiver_links SET status='revoked',revoked_at=now()
        WHERE id=(p_data->>'linkId')::uuid AND patient_id=p_subject AND role='caregiver' RETURNING id INTO link_id;
    ELSE RAISE EXCEPTION 'Unknown sharing action' USING ERRCODE='22023'; END IF;
  END IF;
  IF link_id IS NULL THEN RAISE EXCEPTION 'Link unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
    VALUES(auth.uid(),p_action,p_subject,'care_team',link_id,jsonb_build_object('scopes',scopes));
  RETURN link_id;
END;
$fn$;

CREATE FUNCTION hms_private.doctor_profile(p_action text, p_data jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE p public.profiles; d public.doctors; target uuid; specialties text[]; langs text[]; reg text; council text;
BEGIN
  IF NOT hms_private.actor_is_live() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  SELECT * INTO p FROM public.profiles WHERE auth_user_id=auth.uid();
  IF p_action='read' THEN
    RETURN jsonb_build_object('profile_id',p.id,'role',p.role,'account_code',auth.uid(),'doctor',(SELECT to_jsonb(x) FROM public.doctors x WHERE x.id=p.id));
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR octet_length(p_data::text)>12000 THEN
    RAISE EXCEPTION 'Invalid doctor details' USING ERRCODE='22023'; END IF;
  IF p_action='verify' THEN
    IF p.role<>'admin' THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
    target:=(p_data->>'doctorId')::uuid;
    PERFORM 1 FROM public.profiles WHERE id=target FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=target AND role='doctor') THEN
      RAISE EXCEPTION 'Doctor unavailable' USING ERRCODE='42501'; END IF;
    UPDATE public.doctors SET verified_at=now() WHERE id=target RETURNING * INTO d;
    IF d.id IS NULL THEN RAISE EXCEPTION 'Doctor unavailable' USING ERRCODE='42501'; END IF;
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id) VALUES(auth.uid(),'doctor_verified',target,'doctors',target);
    RETURN to_jsonb(d);
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id=p.id FOR UPDATE;
  IF p_action IS DISTINCT FROM 'register' OR p.role NOT IN ('patient','doctor') THEN
    RAISE EXCEPTION 'Registration unavailable' USING ERRCODE='42501'; END IF;
  reg:=trim(p_data->>'registrationNumber'); council:=trim(p_data->>'council');
  IF length(coalesce(reg,'')) NOT BETWEEN 1 AND 100 OR length(coalesce(council,'')) NOT BETWEEN 1 AND 120
    OR length(coalesce(p_data->>'bio',''))>1200 OR jsonb_typeof(p_data->'specialities') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_data->'languages') IS DISTINCT FROM 'array' OR jsonb_typeof(p_data->'available') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_data->'feeInr') IS DISTINCT FROM 'number' OR jsonb_typeof(p_data->'feeUsd') IS DISTINCT FROM 'number'
    THEN RAISE EXCEPTION 'Complete doctor registration' USING ERRCODE='22023'; END IF;
  SELECT array_agg(trim(value)) INTO specialties FROM jsonb_array_elements_text(p_data->'specialities');
  SELECT array_agg(trim(value)) INTO langs FROM jsonb_array_elements_text(p_data->'languages');
  IF coalesce(cardinality(specialties),0) NOT BETWEEN 1 AND 10 OR coalesce(cardinality(langs),0) NOT BETWEEN 1 AND 10
    OR EXISTS(SELECT 1 FROM unnest(specialties||langs) v WHERE v IS NULL OR length(v) NOT BETWEEN 1 AND 80)
    OR (p_data->>'feeInr')::numeric NOT BETWEEN 0 AND 100000 OR (p_data->>'feeUsd')::numeric NOT BETWEEN 0 AND 2000
    THEN RAISE EXCEPTION 'Check specialities, languages and fees' USING ERRCODE='22023'; END IF;
  INSERT INTO public.doctors(id,registration_number,registering_council,specialities,languages,bio,consult_fee_inr,consult_fee_usd,available)
    VALUES(p.id,reg,council,specialties,langs,trim(coalesce(p_data->>'bio','')),(p_data->>'feeInr')::numeric,(p_data->>'feeUsd')::numeric,(p_data->>'available')::boolean)
    ON CONFLICT(id) DO UPDATE SET registration_number=excluded.registration_number,registering_council=excluded.registering_council,
      specialities=excluded.specialities,languages=excluded.languages,bio=excluded.bio,consult_fee_inr=excluded.consult_fee_inr,
      consult_fee_usd=excluded.consult_fee_usd,available=excluded.available,
      verified_at=CASE WHEN public.doctors.registration_number=excluded.registration_number AND public.doctors.registering_council=excluded.registering_council
        AND public.doctors.specialities=excluded.specialities THEN public.doctors.verified_at ELSE NULL END RETURNING * INTO d;
  UPDATE public.profiles SET role='doctor' WHERE id=p.id;
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id) VALUES(auth.uid(),'doctor_registration',p.id,'doctors',p.id);
  RETURN to_jsonb(d);
END;
$fn$;

CREATE FUNCTION hms_private.care_list(p_section text, p_subject uuid DEFAULT NULL, p_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE rows jsonb; row jsonb; next_id uuid; manages boolean;
BEGIN
  IF NOT hms_private.actor_is_live() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF p_section='directory' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') INTO rows FROM (
      SELECT d.*,p.name FROM public.doctors d JOIN public.profiles p ON p.id=d.id JOIN auth.users u ON u.id=p.auth_user_id
      WHERE d.verified_at IS NOT NULL AND p.role='doctor' AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<now())
        AND (p_cursor IS NULL OR d.id>p_cursor) ORDER BY d.id LIMIT 100
    ) x;
  ELSIF p_section IN ('doctors','caregivers') THEN
    IF NOT hms_private.is_owner(p_subject) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
    IF NOT hms_private.is_self(p_subject) THEN
      INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,metadata) VALUES(auth.uid(),'guardian_read',p_subject,'care_team',jsonb_build_object('section',p_section));
    END IF;
    IF p_section='doctors' THEN
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') INTO rows FROM (
        SELECT l.*,p.name,d.verified_at,d.is_sample FROM public.doctor_patient_links l JOIN public.doctors d ON d.id=l.doctor_id JOIN public.profiles p ON p.id=d.id
        WHERE l.patient_id=p_subject AND (p_cursor IS NULL OR l.id>p_cursor) ORDER BY l.id LIMIT 100
      ) x;
    ELSE
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') INTO rows FROM (
        SELECT l.*,p.name FROM public.caregiver_links l JOIN public.profiles p ON p.auth_user_id=l.caregiver_id
        WHERE l.patient_id=p_subject AND (p_cursor IS NULL OR l.id>p_cursor) ORDER BY l.id LIMIT 100
      ) x;
    END IF;
  ELSIF p_section='incoming' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') INTO rows FROM (
      SELECT l.id,l.patient_id,l.role,l.status,l.granted_scopes,p.name,
        hms_private.can_read(l.patient_id,'summary_only') can_read_summary,hms_private.can_read(l.patient_id,'full_history') can_read_history,
        hms_private.can_read(l.patient_id,'alerts') can_read_alerts
      FROM public.caregiver_links l JOIN public.profiles p ON p.id=l.patient_id
      WHERE l.caregiver_id=auth.uid() AND l.role='caregiver' AND l.status IN ('invited','active') AND l.revoked_at IS NULL
        AND (p_cursor IS NULL OR l.id>p_cursor) ORDER BY l.id LIMIT 100
    ) x;
    FOR row IN SELECT value FROM jsonb_array_elements(rows) LOOP
      INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
        VALUES(auth.uid(),'care_invitation_read',(row->>'patient_id')::uuid,'caregiver_links',(row->>'id')::uuid,jsonb_build_object('status',row->>'status'));
    END LOOP;
  ELSIF p_section='patients' THEN
    IF NOT EXISTS(SELECT 1 FROM public.profiles p JOIN public.doctors d ON d.id=p.id WHERE p.auth_user_id=auth.uid() AND p.role='doctor' AND d.verified_at IS NOT NULL)
      THEN RAISE EXCEPTION 'Verified doctor required' USING ERRCODE='42501'; END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') INTO rows FROM (
      SELECT p.id,p.name,p.dob,p.kind,l.granted_scopes FROM public.doctor_patient_links l JOIN public.profiles p ON p.id=l.patient_id
      JOIN public.profiles dp ON dp.id=l.doctor_id WHERE dp.auth_user_id=auth.uid() AND hms_private.can_read(p.id,'summary_only')
        AND l.status='active' AND l.revoked_at IS NULL AND (p_cursor IS NULL OR p.id>p_cursor) ORDER BY p.id LIMIT 100
    ) x;
    FOR row IN SELECT value FROM jsonb_array_elements(rows) LOOP
      INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
        VALUES(auth.uid(),'doctor_patient_list_read',(row->>'id')::uuid,'profiles',(row->>'id')::uuid,'{"scope":"summary_only"}');
    END LOOP;
  ELSE RAISE EXCEPTION 'Unknown care-team view' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(rows)=100 THEN next_id:=(rows->99->>'id')::uuid; END IF;
  manages:=p_subject IS NOT NULL AND hms_private.is_owner(p_subject);
  RETURN jsonb_build_object('rows',rows,'next_cursor',next_id,'can_manage',manages);
END;
$fn$;

CREATE FUNCTION public.hms_care_change(p_subject uuid,p_action text,p_data jsonb) RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.care_change(p_subject,p_action,p_data); $fn$;
CREATE FUNCTION public.hms_doctor_profile(p_action text,p_data jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.doctor_profile(p_action,p_data); $fn$;
CREATE FUNCTION public.hms_care_list(p_section text,p_subject uuid DEFAULT NULL,p_cursor uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.care_list(p_section,p_subject,p_cursor); $fn$;
REVOKE ALL ON FUNCTION hms_private.care_change(uuid,text,jsonb),hms_private.doctor_profile(text,jsonb),hms_private.care_list(text,uuid,uuid),
  public.hms_care_change(uuid,text,jsonb),public.hms_doctor_profile(text,jsonb),public.hms_care_list(text,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION hms_private.care_change(uuid,text,jsonb),hms_private.doctor_profile(text,jsonb),hms_private.care_list(text,uuid,uuid),
  public.hms_care_change(uuid,text,jsonb),public.hms_doctor_profile(text,jsonb),public.hms_care_list(text,uuid,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
