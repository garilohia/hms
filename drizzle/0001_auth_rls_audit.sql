-- Custom SQL migration file, put your code below! --
-- Privileged operations live outside the exposed schema. Public wrappers are invokers.
CREATE SCHEMA IF NOT EXISTS hms_private;
REVOKE ALL ON SCHEMA hms_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA hms_private TO authenticated, service_role;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_auth_fk FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_owner_fk FOREIGN KEY (owner_account_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.caregiver_links ADD CONSTRAINT caregivers_account_fk FOREIGN KEY (caregiver_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE FUNCTION hms_private.actor_is_live() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM auth.users WHERE id = (SELECT auth.uid())
      AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until < now())
  );
$fn$;
CREATE FUNCTION hms_private.is_self(p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT hms_private.actor_is_live() AND EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_subject AND auth_user_id = (SELECT auth.uid()) AND kind = 'self'
  );
$fn$;
CREATE FUNCTION hms_private.is_owner(p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT hms_private.actor_is_live() AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = p_subject AND p.owner_account_id = (SELECT auth.uid())
      AND (p.kind = 'self' OR EXISTS (
        SELECT 1 FROM public.caregiver_links c WHERE c.patient_id = p.id
          AND c.caregiver_id = (SELECT auth.uid()) AND c.role = 'guardian'
          AND c.status = 'active' AND c.revoked_at IS NULL
      ))
  );
$fn$;

-- Account creation is guarded in Postgres, including direct Auth API calls.
-- Metadata is used once as sign-up input, never as an authorization claim.
CREATE FUNCTION hms_private.on_auth_user_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE birth date;
BEGIN
  IF coalesce(NEW.raw_user_meta_data->>'dob', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'A valid date of birth is required for adult signup' USING ERRCODE = '23514';
  END IF;
  birth := (NEW.raw_user_meta_data->>'dob')::date;
  IF birth > (current_date - interval '18 years')::date OR birth < (current_date - interval '120 years')::date THEN
    RAISE EXCEPTION 'Under-18s need a guardian-created dependent profile' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.profiles(auth_user_id, owner_account_id, name, dob)
  VALUES (NEW.id, NEW.id, coalesce(nullif(trim(NEW.raw_user_meta_data->>'name'), ''), 'Member'), birth);
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER hms_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION hms_private.on_auth_user_created();

CREATE FUNCTION hms_private.check_guardian_ownership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE subject uuid;
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    subject := coalesce(NEW.id, OLD.id);
  ELSE
    subject := coalesce(NEW.patient_id, OLD.patient_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = subject AND p.kind = 'dependent' AND NOT EXISTS (
      SELECT 1 FROM public.caregiver_links c
      WHERE c.patient_id = p.id AND c.caregiver_id = p.owner_account_id
        AND c.role = 'guardian' AND c.status = 'active' AND c.revoked_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'A dependent must retain its owning guardian' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$fn$;
CREATE CONSTRAINT TRIGGER hms_dependent_guardian AFTER INSERT OR UPDATE ON public.profiles
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hms_private.check_guardian_ownership();
CREATE CONSTRAINT TRIGGER hms_guardian_preserved AFTER INSERT OR UPDATE OR DELETE ON public.caregiver_links
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hms_private.check_guardian_ownership();

-- Only self-reads bypass the audit function. Guardians also use audited reads.
DO $policies$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['consents','data_sources','metrics','daily_summaries','baselines','alerts','insights','cycle_logs','documents','summary_snapshots']
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', tab);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', tab);
    EXECUTE format('CREATE POLICY self_read ON public.%I FOR SELECT TO authenticated USING (hms_private.is_self(user_id))', tab);
  END LOOP;
END;
$policies$;
REVOKE ALL ON public.profiles, public.alert_rules, public.doctors, public.doctor_patient_links,
  public.caregiver_links, public.consults, public.messages, public.device_catalog, public.audit_log FROM anon, authenticated;
GRANT SELECT ON public.profiles, public.alert_rules, public.doctors, public.doctor_patient_links,
  public.caregiver_links, public.consults, public.messages, public.device_catalog, public.audit_log TO authenticated;
GRANT SELECT ON public.device_catalog TO anon;
CREATE POLICY self_read ON public.profiles FOR SELECT TO authenticated USING (hms_private.is_self(id));
CREATE POLICY rule_read ON public.alert_rules FOR SELECT TO authenticated USING (hms_private.actor_is_live() AND (user_id IS NULL OR hms_private.is_self(user_id)));
CREATE POLICY doctor_directory ON public.doctors FOR SELECT TO authenticated USING (hms_private.actor_is_live() AND (verified_at IS NOT NULL OR hms_private.is_self(id)));
CREATE POLICY doctor_links_read ON public.doctor_patient_links FOR SELECT TO authenticated USING (hms_private.is_self(patient_id));
CREATE POLICY caregiver_links_read ON public.caregiver_links FOR SELECT TO authenticated USING (hms_private.is_self(patient_id));
CREATE POLICY consults_read ON public.consults FOR SELECT TO authenticated USING (hms_private.is_self(patient_id));
CREATE POLICY messages_read ON public.messages FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.consults c WHERE c.id = consult_id AND hms_private.is_self(c.patient_id))
);
CREATE POLICY catalog_read ON public.device_catalog FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY audit_self_read ON public.audit_log FOR SELECT TO authenticated USING (hms_private.is_self(target_user_id));

CREATE FUNCTION hms_private.list_profiles() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE result jsonb;
BEGIN
  IF NOT hms_private.actor_is_live() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.audit_log(actor_id, action, target_user_id, target_table, target_id)
    SELECT auth.uid(), 'guardian_read', p.id, 'profiles', p.id
    FROM public.profiles p WHERE p.kind = 'dependent' AND hms_private.is_owner(p.id);
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at), '[]'::jsonb) INTO result
    FROM public.profiles p WHERE hms_private.is_owner(p.id);
  RETURN result;
END;
$fn$;

CREATE FUNCTION hms_private.create_dependent(p_name text, p_dob date, p_policy text, p_ip_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE subject uuid;
BEGIN
  IF NOT hms_private.actor_is_live() OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE auth_user_id = auth.uid() AND dob <= (current_date - interval '18 years')::date
  ) THEN RAISE EXCEPTION 'Adult guardian required' USING ERRCODE = '42501'; END IF;
  IF p_dob IS NULL OR p_dob > current_date OR p_dob <= (current_date - interval '18 years')::date
    OR length(trim(coalesce(p_name,''))) NOT BETWEEN 1 AND 120
    OR length(coalesce(p_policy,'')) NOT BETWEEN 1 AND 80 OR coalesce(p_ip_hash,'') !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'Valid dependent details and guardian consent are required' USING ERRCODE = '23514'; END IF;
  INSERT INTO public.profiles(owner_account_id, kind, name, dob)
    VALUES (auth.uid(), 'dependent', trim(p_name), p_dob) RETURNING id INTO subject;
  INSERT INTO public.caregiver_links(patient_id, caregiver_id, role, status, granted_scopes, invited_by)
    VALUES (subject, auth.uid(), 'guardian', 'active', ARRAY['summary_only','full_history','alerts']::public.sharing_scope[], 'caregiver');
  INSERT INTO public.consents(user_id, granted_by, authority, consent_type, policy_version, ip_hash)
    VALUES (subject, auth.uid(), 'guardian', 'data_ingestion', p_policy, p_ip_hash);
  INSERT INTO public.audit_log(actor_id, action, target_user_id, target_table, target_id)
    VALUES (auth.uid(), 'guardian_create_dependent', subject, 'profiles', subject);
  RETURN subject;
END;
$fn$;

CREATE FUNCTION hms_private.record_consent(p_subject uuid, p_type public.consent_type, p_grant boolean, p_policy text, p_ip_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE authority public.consent_authority;
BEGIN
  IF NOT hms_private.is_owner(p_subject) THEN RAISE EXCEPTION 'Owner consent required' USING ERRCODE = '42501'; END IF;
  IF p_grant IS NULL OR length(coalesce(p_policy,'')) NOT BETWEEN 1 AND 80 OR coalesce(p_ip_hash,'') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Valid consent evidence is required' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_subject FOR UPDATE;
  authority := CASE WHEN hms_private.is_self(p_subject) THEN 'self'::public.consent_authority ELSE 'guardian'::public.consent_authority END;
  UPDATE public.consents SET revoked_at = now() WHERE user_id = p_subject AND consent_type = p_type AND revoked_at IS NULL;
  IF p_grant THEN
    INSERT INTO public.consents(user_id, granted_by, authority, consent_type, policy_version, ip_hash)
      VALUES (p_subject, auth.uid(), authority, p_type, p_policy, p_ip_hash);
  END IF;
  INSERT INTO public.audit_log(actor_id, action, target_user_id, target_table, metadata)
    VALUES (auth.uid(), CASE WHEN p_grant THEN 'consent_granted' ELSE 'consent_revoked' END, p_subject, 'consents',
      jsonb_build_object('consent_type',p_type,'authority',authority,'policy_version',p_policy));
END;
$fn$;

CREATE FUNCTION hms_private.read_patient(p_subject uuid, p_scope text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE p public.profiles; result jsonb; permitted boolean := false; guardian boolean := false;
BEGIN
  IF NOT hms_private.actor_is_live() OR p_scope NOT IN ('summary_only','full_history','alerts') OR p_scope IS NULL THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = p_subject;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501'; END IF;
  guardian := p.kind = 'dependent' AND hms_private.is_owner(p_subject);
  permitted := hms_private.is_self(p_subject) OR guardian;
  IF NOT permitted AND EXISTS (
    SELECT 1 FROM public.consents WHERE user_id = p_subject AND consent_type = 'doctor_sharing' AND revoked_at IS NULL
  ) THEN
    permitted := EXISTS (
      SELECT 1 FROM public.doctor_patient_links l JOIN public.doctors d ON d.id = l.doctor_id
      JOIN public.profiles dp ON dp.id = d.id
      WHERE l.patient_id = p_subject AND dp.auth_user_id = auth.uid() AND dp.role = 'doctor'
        AND d.verified_at IS NOT NULL AND l.status = 'active' AND l.revoked_at IS NULL
        AND (p_scope::public.sharing_scope = ANY(l.granted_scopes) OR (p_scope = 'summary_only' AND 'full_history' = ANY(l.granted_scopes)))
    ) OR EXISTS (
      SELECT 1 FROM public.caregiver_links l WHERE l.patient_id = p_subject AND l.caregiver_id = auth.uid()
        AND l.role = 'caregiver' AND l.status = 'active' AND l.revoked_at IS NULL
        AND (p_scope::public.sharing_scope = ANY(l.granted_scopes) OR (p_scope = 'summary_only' AND 'full_history' = ANY(l.granted_scopes)))
    );
  END IF;
  IF NOT permitted THEN RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501'; END IF;
  IF NOT hms_private.is_self(p_subject) THEN
    INSERT INTO public.audit_log(actor_id, action, target_user_id, target_table, target_id, metadata)
    VALUES (auth.uid(), CASE WHEN guardian THEN 'guardian_read' ELSE 'shared_read' END,
      p_subject, CASE p_scope WHEN 'full_history' THEN 'metrics' WHEN 'alerts' THEN 'alerts' ELSE 'daily_summaries' END,
      p_subject, jsonb_build_object('scope',p_scope));
  END IF;
  result := jsonb_build_object('profile', jsonb_build_object('id',p.id,'name',p.name,'dob',p.dob,'sex_at_birth',p.sex_at_birth,'timezone',p.timezone),
    'consent_given_by_guardian', EXISTS (SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='doctor_sharing' AND authority='guardian' AND revoked_at IS NULL));
  IF p_scope = 'full_history' THEN
    result := result || jsonb_build_object('metrics', (SELECT coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM
      (SELECT * FROM public.metrics WHERE user_id = p_subject ORDER BY recorded_at DESC, id LIMIT 5000) m));
  ELSIF p_scope = 'alerts' THEN
    result := result || jsonb_build_object('alerts', (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) FROM
      (SELECT * FROM public.alerts WHERE user_id = p_subject ORDER BY fired_at DESC LIMIT 1000) a));
  ELSE
    result := result || jsonb_build_object('daily_summaries', (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM
      (SELECT * FROM public.daily_summaries WHERE user_id = p_subject ORDER BY day DESC LIMIT 365) s));
  END IF;
  RETURN result;
END;
$fn$;

-- Invoker wrappers expose only audited, checked functions to the Data API.
CREATE FUNCTION public.hms_list_profiles() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $fn$ SELECT hms_private.list_profiles(); $fn$;
CREATE FUNCTION public.hms_create_dependent(p_name text, p_dob date, p_policy text, p_ip_hash text) RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $fn$ SELECT hms_private.create_dependent(p_name, p_dob, p_policy, p_ip_hash); $fn$;
CREATE FUNCTION public.hms_record_consent(p_subject uuid, p_type public.consent_type, p_grant boolean, p_policy text, p_ip_hash text) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $fn$ SELECT hms_private.record_consent(p_subject, p_type, p_grant, p_policy, p_ip_hash); $fn$;
CREATE FUNCTION public.hms_read_patient(p_subject uuid, p_scope text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $fn$ SELECT hms_private.read_patient(p_subject, p_scope); $fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hms_private FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hms_private.actor_is_live(), hms_private.is_self(uuid), hms_private.is_owner(uuid),
  hms_private.list_profiles(), hms_private.create_dependent(text,date,text,text),
  hms_private.record_consent(uuid,public.consent_type,boolean,text,text), hms_private.read_patient(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.hms_list_profiles(), public.hms_create_dependent(text,date,text,text),
  public.hms_record_consent(uuid,public.consent_type,boolean,text,text), public.hms_read_patient(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hms_list_profiles(), public.hms_create_dependent(text,date,text,text),
  public.hms_record_consent(uuid,public.consent_type,boolean,text,text), public.hms_read_patient(uuid,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
