ALTER TABLE public.account_deletions ADD CONSTRAINT deletion_account_fk FOREIGN KEY(account_id) REFERENCES auth.users(id) ON DELETE CASCADE;
REVOKE ALL ON public.account_deletions FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION hms_private.actor_is_live() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
  SELECT auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM auth.users WHERE id=auth.uid() AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<now()))
    AND NOT EXISTS(SELECT 1 FROM public.account_deletions WHERE account_id=auth.uid());
$fn$;

-- Serialize new dependents with deletion of the owning account. Recheck after locking.
CREATE OR REPLACE FUNCTION hms_private.create_dependent(p_name text,p_dob date,p_policy text,p_ip_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE subject uuid;
BEGIN
  PERFORM id FROM public.profiles WHERE auth_user_id=auth.uid() FOR UPDATE;
  IF NOT hms_private.actor_is_live() OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE auth_user_id=auth.uid() AND dob<=(current_date-interval '18 years')::date)
    THEN RAISE EXCEPTION 'Adult guardian required' USING ERRCODE='42501'; END IF;
  IF p_dob IS NULL OR p_dob>current_date OR p_dob<=(current_date-interval '18 years')::date
    OR length(trim(coalesce(p_name,''))) NOT BETWEEN 1 AND 120 OR length(coalesce(p_policy,'')) NOT BETWEEN 1 AND 80
    OR coalesce(p_ip_hash,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Valid dependent details and guardian consent required' USING ERRCODE='23514'; END IF;
  INSERT INTO public.profiles(owner_account_id,kind,name,dob) VALUES(auth.uid(),'dependent',trim(p_name),p_dob) RETURNING id INTO subject;
  INSERT INTO public.caregiver_links(patient_id,caregiver_id,role,status,granted_scopes,invited_by)
    VALUES(subject,auth.uid(),'guardian','active',ARRAY['summary_only','full_history','alerts']::public.sharing_scope[],'caregiver');
  INSERT INTO public.consents(user_id,granted_by,authority,consent_type,policy_version,ip_hash) VALUES(subject,auth.uid(),'guardian','data_ingestion',p_policy,p_ip_hash);
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id) VALUES(auth.uid(),'guardian_create_dependent',subject,'profiles',subject);
  RETURN subject;
END;
$fn$;

CREATE FUNCTION hms_private.account_deletion_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE d public.account_deletions;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=auth.uid() AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<now()))
    THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  SELECT * INTO d FROM public.account_deletions WHERE account_id=auth.uid();
  RETURN jsonb_build_object('pending',d.account_id IS NOT NULL,'stage',d.stage,'profile_count',coalesce(cardinality(d.profile_ids),0));
END;
$fn$;

CREATE FUNCTION hms_private.begin_account_deletion(p_confirm_dependents boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE a uuid:=auth.uid(); subjects uuid[]; d public.account_deletions;
BEGIN
  IF a IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=a AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<now()))
    THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  -- The self-profile lock also serializes dependent creation. Re-select subjects after it.
  PERFORM id FROM public.profiles WHERE auth_user_id=a FOR UPDATE;
  PERFORM id FROM public.profiles WHERE owner_account_id=a ORDER BY id FOR UPDATE;
  SELECT * INTO d FROM public.account_deletions WHERE account_id=a FOR UPDATE;
  IF d.account_id IS NOT NULL THEN RETURN to_jsonb(d); END IF;
  IF p_confirm_dependents IS DISTINCT FROM true AND EXISTS(SELECT 1 FROM public.profiles WHERE owner_account_id=a AND kind='dependent')
    THEN RAISE EXCEPTION 'Explicit confirmation of dependent deletion required' USING ERRCODE='23514'; END IF;
  SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO subjects FROM public.profiles WHERE owner_account_id=a;
  INSERT INTO public.account_deletions(account_id,profile_ids) VALUES(a,subjects) RETURNING * INTO d;
  UPDATE public.consents SET revoked_at=now() WHERE user_id=ANY(subjects) AND revoked_at IS NULL;
  UPDATE public.doctor_patient_links SET status='revoked',revoked_at=now() WHERE (patient_id=ANY(subjects) OR doctor_id=ANY(subjects)) AND status<>'revoked';
  -- Keep the mandatory guardian invariant until the dependent itself is purged.
  UPDATE public.caregiver_links SET status='revoked',revoked_at=now() WHERE role='caregiver' AND (patient_id=ANY(subjects) OR caregiver_id=a) AND status<>'revoked';
  UPDATE public.doctors SET available=false,verified_at=NULL WHERE id=ANY(subjects);
  UPDATE public.consults SET status='cancelled' WHERE (patient_id=ANY(subjects) OR doctor_id=ANY(subjects)) AND status IN ('requested','accepted','scheduled');
  UPDATE public.profile_transfers SET revoked_at=now() WHERE (guardian_account_id=a OR recipient_account_id=a) AND accepted_at IS NULL AND revoked_at IS NULL;
  UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL,payload=NULL,last_error='AccountDeletion'
    WHERE (user_id=ANY(subjects) OR (recipient_kind='caregiver' AND recipient_key=a::text)) AND status='pending';
  INSERT INTO public.audit_log(actor_id,action,target_table,target_id) VALUES(a,'account_deletion_requested','account_deletions',a);
  RETURN to_jsonb(d);
END;
$fn$;

-- Server-only: call only after Storage API removal has succeeded for every saved prefix.
-- Database-owner execution also requires the already-verified actor's bound claims.
CREATE FUNCTION hms_private.finish_account_deletion() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE a uuid:=auth.uid(); d public.account_deletions;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'Bound actor required' USING ERRCODE='42501'; END IF;
  PERFORM id FROM public.profiles WHERE owner_account_id=a ORDER BY id FOR UPDATE;
  SELECT * INTO d FROM public.account_deletions WHERE account_id=a FOR UPDATE;
  IF d.account_id IS NULL OR d.stage NOT IN ('storage_removed','health_removed') THEN RAISE EXCEPTION 'Storage removal must finish first' USING ERRCODE='42501'; END IF;
  IF d.stage='health_removed' THEN RETURN; END IF;
  UPDATE public.messages SET sender_id=NULL WHERE sender_id=a;
  UPDATE public.consents SET granted_by=NULL,ip_hash='' WHERE granted_by=a AND NOT(user_id=ANY(d.profile_ids));
  DELETE FROM public.alert_deliveries WHERE recipient_kind='caregiver' AND recipient_key=a::text;
  UPDATE public.audit_log l SET actor_id=CASE WHEN actor_id=a OR target_user_id=ANY(d.profile_ids) THEN NULL ELSE actor_id END,
    target_user_id=CASE WHEN target_user_id=ANY(d.profile_ids) THEN NULL ELSE target_user_id END,target_id=NULL,metadata='{}'::jsonb
    WHERE actor_id=a OR target_user_id=ANY(d.profile_ids) OR EXISTS(SELECT 1 FROM unnest(d.profile_ids||ARRAY[a]) x(id) WHERE l.target_id=x.id OR position(x.id::text in l.metadata::text)>0);
  DELETE FROM public.profiles WHERE owner_account_id=a AND id=ANY(d.profile_ids);
  IF EXISTS(SELECT 1 FROM public.profiles WHERE owner_account_id=a) THEN RAISE EXCEPTION 'Account profile set changed; retry safely' USING ERRCODE='40001'; END IF;
  UPDATE public.account_deletions SET stage='health_removed' WHERE account_id=a;
END;
$fn$;

CREATE FUNCTION public.hms_account_deletion_status() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.account_deletion_status(); $fn$;
CREATE FUNCTION public.hms_begin_account_deletion(p_confirm_dependents boolean) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.begin_account_deletion(p_confirm_dependents); $fn$;
REVOKE ALL ON FUNCTION hms_private.account_deletion_status(),hms_private.begin_account_deletion(boolean),public.hms_account_deletion_status(),public.hms_begin_account_deletion(boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION hms_private.account_deletion_status(),hms_private.begin_account_deletion(boolean),public.hms_account_deletion_status(),public.hms_begin_account_deletion(boolean) TO authenticated;
REVOKE ALL ON FUNCTION hms_private.finish_account_deletion() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION hms_private.transfer_at(p_subject uuid,p_action text,p_data jsonb,p_policy text,p_ip_hash text,p_now timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE p public.profiles; recipient public.profiles; offer public.profile_transfers; recipient_id uuid; recipient_profile uuid; tab text; occupied boolean; today date;
BEGIN
  IF NOT hms_private.actor_is_live() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR octet_length(p_data::text)>4096 OR p_now IS NULL THEN
    RAISE EXCEPTION 'Invalid transfer request' USING ERRCODE='22023'; END IF;
  today:=p_now::date;
  IF p_action='offer' THEN recipient_id:=(p_data->>'recipientId')::uuid;
  ELSE
    SELECT * INTO offer FROM public.profile_transfers WHERE id=(p_data->>'offerId')::uuid AND user_id=p_subject;
    recipient_id:=offer.recipient_account_id;
  END IF;
  SELECT id INTO recipient_profile FROM public.profiles WHERE auth_user_id=recipient_id;
  -- Consistent order across concurrent offers/acceptances and the two profile writes.
  PERFORM id FROM public.profiles WHERE id IN (p_subject,recipient_profile) ORDER BY id FOR UPDATE;
  IF NOT hms_private.actor_is_live() THEN RAISE EXCEPTION 'Account is being deleted' USING ERRCODE='42501'; END IF;
  SELECT * INTO p FROM public.profiles WHERE id=p_subject;
  SELECT * INTO recipient FROM public.profiles WHERE id=recipient_profile;
  IF p_action='offer' THEN
    IF p.kind IS DISTINCT FROM 'dependent' OR NOT hms_private.is_owner(p_subject) OR p.dob>(today-interval '18 years')::date
      THEN RAISE EXCEPTION 'Owning guardian and an adult dependent required' USING ERRCODE='42501'; END IF;
    IF recipient.id IS NULL OR recipient_id=auth.uid() OR recipient.kind<>'self' OR recipient.role<>'patient' OR recipient.dob<>p.dob
      OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=recipient_id AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<p_now))
      THEN RAISE EXCEPTION 'Confirmed recipient with matching date of birth required' USING ERRCODE='42501'; END IF;
    UPDATE public.profile_transfers SET revoked_at=p_now WHERE user_id=p.id AND accepted_at IS NULL AND revoked_at IS NULL;
    INSERT INTO public.profile_transfers(user_id,guardian_account_id,recipient_account_id,created_at,expires_at)
      VALUES(p.id,auth.uid(),recipient_id,p_now,p_now+interval '7 days') RETURNING * INTO offer;
  ELSIF p_action IN ('accept','cancel') THEN
    SELECT * INTO offer FROM public.profile_transfers WHERE id=offer.id AND user_id=p_subject FOR UPDATE;
    IF offer.id IS NULL OR offer.accepted_at IS NOT NULL OR offer.revoked_at IS NOT NULL OR offer.expires_at<=p_now
      THEN RAISE EXCEPTION 'Transfer offer unavailable' USING ERRCODE='42501'; END IF;
    IF p_action='cancel' THEN
      IF NOT (auth.uid()=offer.recipient_account_id OR (auth.uid()=offer.guardian_account_id AND hms_private.is_owner(p.id))) THEN
        RAISE EXCEPTION 'Only the parties can cancel' USING ERRCODE='42501'; END IF;
      UPDATE public.profile_transfers SET revoked_at=p_now WHERE id=offer.id;
    ELSE
      IF auth.uid()<>offer.recipient_account_id OR p.kind IS DISTINCT FROM 'dependent' OR p.owner_account_id<>offer.guardian_account_id
        OR p.dob>(today-interval '18 years')::date OR recipient.id IS NULL OR recipient.dob<>p.dob OR recipient.role<>'patient'
        OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=recipient_id AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<p_now))
        THEN RAISE EXCEPTION 'Adult recipient and unchanged guardian ownership required' USING ERRCODE='42501'; END IF;
      IF p_data->'acceptOwnership' IS DISTINCT FROM 'true'::jsonb OR p_data->'replaceEmptyProfile' IS DISTINCT FROM 'true'::jsonb
        OR p_data->'consent' IS DISTINCT FROM 'true'::jsonb OR p_data->'disclaimer' IS DISTINCT FROM 'true'::jsonb
        OR length(coalesce(p_policy,'')) NOT BETWEEN 1 AND 80 OR coalesce(p_ip_hash,'') !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'Ownership, replacement, processing consent and disclaimer acceptance required' USING ERRCODE='23514'; END IF;
      IF recipient.emergency_contact IS NOT NULL OR cardinality(recipient.medications)>0
        OR EXISTS(SELECT 1 FROM public.profiles WHERE owner_account_id=recipient_id AND id<>recipient.id)
        OR EXISTS(SELECT 1 FROM public.doctors WHERE id=recipient.id)
        OR EXISTS(SELECT 1 FROM public.doctor_patient_links WHERE patient_id=recipient.id)
        OR EXISTS(SELECT 1 FROM public.caregiver_links WHERE patient_id=recipient.id OR caregiver_id=recipient_id)
        OR EXISTS(SELECT 1 FROM public.consults WHERE patient_id=recipient.id OR doctor_id=recipient.id)
        THEN RAISE EXCEPTION 'Recipient must use an empty signup profile' USING ERRCODE='23514'; END IF;
      FOREACH tab IN ARRAY ARRAY['consents','data_sources','metrics','daily_summaries','baselines','alerts','alert_rules','alert_deliveries','insights','cycle_logs','documents','summary_jobs','summary_snapshots'] LOOP
        EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE user_id=$1)',tab) INTO occupied USING recipient.id;
        IF occupied THEN RAISE EXCEPTION 'Recipient profile already contains data; nothing has been replaced' USING ERRCODE='23514'; END IF;
      END LOOP;
      -- Replacement was explicitly accepted and every dependent table was checked under the profile lock.
      DELETE FROM public.profiles WHERE id=recipient.id AND auth_user_id=recipient_id;
      UPDATE public.profiles SET kind='self',auth_user_id=recipient_id,owner_account_id=recipient_id,emergency_contact=NULL,onboarding_completed_at=p_now WHERE id=p.id;
      UPDATE public.caregiver_links SET status='revoked',revoked_at=p_now WHERE patient_id=p.id AND status<>'revoked';
      UPDATE public.doctor_patient_links SET status='revoked',revoked_at=p_now WHERE patient_id=p.id AND status<>'revoked';
      UPDATE public.consults SET status='cancelled' WHERE patient_id=p.id AND status IN ('requested','accepted','scheduled');
      UPDATE public.consents SET revoked_at=p_now WHERE user_id=p.id AND revoked_at IS NULL;
      INSERT INTO public.consents(user_id,granted_by,authority,consent_type,granted_at,policy_version,ip_hash)
        VALUES(p.id,recipient_id,'self','data_ingestion',p_now,p_policy,p_ip_hash);
      UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL,last_error='OwnershipTransferred' WHERE user_id=p.id AND status='pending';
      UPDATE public.profile_transfers SET accepted_at=p_now WHERE id=offer.id;
    END IF;
  ELSE RAISE EXCEPTION 'Unknown transfer action' USING ERRCODE='22023'; END IF;
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,at,metadata)
    VALUES(auth.uid(),'profile_transfer_'||p_action,p_subject,'profile_transfers',offer.id,p_now,
      jsonb_build_object('guardian',offer.guardian_account_id,'recipient',offer.recipient_account_id));
  RETURN offer.id;
END;
$fn$;
NOTIFY pgrst,'reload schema';
