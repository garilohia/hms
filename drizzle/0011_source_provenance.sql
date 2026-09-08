-- Point inspection never depends on loading the first page of source records.
CREATE FUNCTION hms_private.patient_source(p_subject uuid,p_source uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE result jsonb;
BEGIN
  IF NOT hms_private.can_read(p_subject,'full_history') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('id',id,'provider',provider,'label',metadata->>'label') INTO result FROM public.data_sources WHERE id=p_source AND user_id=p_subject;
  IF result IS NULL THEN RAISE EXCEPTION 'Source unavailable' USING ERRCODE='42501'; END IF;
  IF NOT hms_private.is_self(p_subject) THEN INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id)
    VALUES(auth.uid(),'shared_source_read',p_subject,'data_sources',p_source); END IF;
  RETURN result;
END; $fn$;
CREATE FUNCTION public.hms_patient_source(p_subject uuid,p_source uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $fn$
  SELECT hms_private.patient_source(p_subject,p_source); $fn$;
REVOKE ALL ON FUNCTION hms_private.patient_source(uuid,uuid),public.hms_patient_source(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION hms_private.patient_source(uuid,uuid),public.hms_patient_source(uuid,uuid) TO authenticated;
