ALTER TABLE public.profile_transfers ADD CONSTRAINT transfer_guardian_account FOREIGN KEY(guardian_account_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.profile_transfers ADD CONSTRAINT transfer_recipient_account FOREIGN KEY(recipient_account_id) REFERENCES auth.users(id) ON DELETE CASCADE;
REVOKE ALL ON public.profile_transfers FROM PUBLIC,anon,authenticated;

-- Only the wrapper can supply production time. No application role can execute this helper.
CREATE FUNCTION hms_private.transfer_at(p_subject uuid,p_action text,p_data jsonb,p_policy text,p_ip_hash text,p_now timestamptz) RETURNS uuid
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

CREATE FUNCTION hms_private.transfer_change(p_subject uuid,p_action text,p_data jsonb,p_policy text,p_ip_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN RETURN hms_private.transfer_at(p_subject,p_action,p_data,p_policy,p_ip_hash,now()); END;
$fn$;

CREATE FUNCTION hms_private.transfer_list(p_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE rows jsonb; row jsonb;
BEGIN
  IF NOT hms_private.actor_is_live() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (
    SELECT t.id,t.user_id,t.guardian_account_id,t.recipient_account_id,t.expires_at,p.name,p.dob
    FROM public.profile_transfers t JOIN public.profiles p ON p.id=t.user_id WHERE t.accepted_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()
      AND (t.recipient_account_id=auth.uid() OR (t.guardian_account_id=auth.uid() AND hms_private.is_owner(p.id)))
      AND (p_cursor IS NULL OR t.id>p_cursor) ORDER BY t.id LIMIT 100
  ) x;
  FOR row IN SELECT value FROM jsonb_array_elements(rows) LOOP
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id) VALUES(auth.uid(),'transfer_offer_read',(row->>'user_id')::uuid,'profile_transfers',(row->>'id')::uuid);
  END LOOP;
  RETURN jsonb_build_object('rows',rows,'next_cursor',CASE WHEN jsonb_array_length(rows)=100 THEN rows->99->>'id' ELSE NULL END);
END;
$fn$;
CREATE FUNCTION public.hms_transfer_change(p_subject uuid,p_action text,p_data jsonb,p_policy text,p_ip_hash text) RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.transfer_change(p_subject,p_action,p_data,p_policy,p_ip_hash); $fn$;
CREATE FUNCTION public.hms_transfer_list(p_cursor uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$ SELECT hms_private.transfer_list(p_cursor); $fn$;
REVOKE ALL ON FUNCTION hms_private.transfer_at(uuid,text,jsonb,text,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION hms_private.transfer_change(uuid,text,jsonb,text,text),hms_private.transfer_list(uuid),public.hms_transfer_change(uuid,text,jsonb,text,text),public.hms_transfer_list(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION hms_private.transfer_change(uuid,text,jsonb,text,text),hms_private.transfer_list(uuid),public.hms_transfer_change(uuid,text,jsonb,text,text),public.hms_transfer_list(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
