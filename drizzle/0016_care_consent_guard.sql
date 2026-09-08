-- Serialize consent authority with ownership conversion and other profile writes.
CREATE OR REPLACE FUNCTION hms_private.record_consent(p_subject uuid,p_type public.consent_type,p_grant boolean,p_policy text,p_ip_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE authority public.consent_authority;
BEGIN
  PERFORM 1 FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF NOT hms_private.is_owner(p_subject) THEN RAISE EXCEPTION 'Owner consent required' USING ERRCODE='42501'; END IF;
  IF p_type IS NULL OR p_grant IS NULL OR length(coalesce(p_policy,'')) NOT BETWEEN 1 AND 80 OR coalesce(p_ip_hash,'') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Valid consent evidence required' USING ERRCODE='23514'; END IF;
  authority:=CASE WHEN hms_private.is_self(p_subject) THEN 'self'::public.consent_authority ELSE 'guardian'::public.consent_authority END;
  UPDATE public.consents SET revoked_at=now() WHERE user_id=p_subject AND consent_type=p_type AND revoked_at IS NULL;
  IF p_grant THEN
    INSERT INTO public.consents(user_id,granted_by,authority,consent_type,policy_version,ip_hash) VALUES(p_subject,auth.uid(),authority,p_type,p_policy,p_ip_hash);
  END IF;
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,metadata)
    VALUES(auth.uid(),CASE WHEN p_grant THEN 'consent_granted' ELSE 'consent_revoked' END,p_subject,'consents',
      jsonb_build_object('consent_type',p_type,'authority',authority,'policy_version',p_policy));
END;
$fn$;

CREATE OR REPLACE FUNCTION hms_private.medications(p_subject uuid,p_items jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE items text[];
BEGIN
  PERFORM 1 FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF NOT hms_private.is_owner(p_subject) OR NOT EXISTS(SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='data_ingestion' AND revoked_at IS NULL)
    THEN RAISE EXCEPTION 'Owner and processing consent required' USING ERRCODE='42501'; END IF;
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
NOTIFY pgrst,'reload schema';
