CREATE TABLE "monitoring_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"author_account_id" uuid NOT NULL,
	"author_role" text NOT NULL,
	"metric_type" "metric_type" NOT NULL,
	"comparator" text NOT NULL,
	"threshold_type" text DEFAULT 'absolute' NOT NULL,
	"value" numeric NOT NULL,
	"min_duration_s" integer DEFAULT 0 NOT NULL,
	"severity" "alert_severity" DEFAULT 'attention' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_rule_author_role" CHECK ("monitoring_rules"."author_role" IN ('owner','caregiver','doctor')),
	CONSTRAINT "monitoring_rule_comparator" CHECK ("monitoring_rules"."comparator" IN ('lt','lte','gt','gte')),
	CONSTRAINT "monitoring_rule_threshold_type" CHECK ("monitoring_rules"."threshold_type" IN ('absolute','baseline_deviation')),
	CONSTRAINT "monitoring_rule_bounds" CHECK ("monitoring_rules"."value" BETWEEN 0 AND 10000 AND "monitoring_rules"."min_duration_s" BETWEEN 0 AND 86400)
);
--> statement-breakpoint
ALTER TABLE "monitoring_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_deliveries" DROP CONSTRAINT "delivery_kind";--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "monitoring_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "monitoring_rules" ADD CONSTRAINT "monitoring_rules_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.monitoring_rules ADD CONSTRAINT monitoring_rules_author_account_fk FOREIGN KEY(author_account_id) REFERENCES auth.users(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "monitoring_rules_patient_idx" ON "monitoring_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "monitoring_rules_author_idx" ON "monitoring_rules" USING btree ("author_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monitoring_rules_author_metric" ON "monitoring_rules" USING btree ("user_id","author_account_id","metric_type","comparator");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_monitoring_rule_id_monitoring_rules_id_fk" FOREIGN KEY ("monitoring_rule_id") REFERENCES "public"."monitoring_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_monitoring_rule_idx" ON "alerts" USING btree ("monitoring_rule_id");--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "delivery_kind" CHECK ("alert_deliveries"."recipient_kind" IN ('owner','caregiver','monitor','contact'));--> statement-breakpoint

-- Monitoring thresholds are private and can only be reached through the checked RPC below.
ALTER TABLE public.monitoring_rules FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.monitoring_rules FROM PUBLIC,anon,authenticated;--> statement-breakpoint

CREATE FUNCTION hms_private.disable_deleted_monitor_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  UPDATE public.monitoring_rules SET enabled=false,updated_at=now() WHERE author_account_id=NEW.account_id;
  UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL,payload=NULL,last_error='AccountDeletion'
    WHERE recipient_kind='monitor' AND recipient_key=NEW.account_id::text AND status='pending';
  RETURN NEW;
END;
$fn$;--> statement-breakpoint
CREATE TRIGGER disable_monitor_rules_on_account_deletion AFTER INSERT ON public.account_deletions
FOR EACH ROW EXECUTE FUNCTION hms_private.disable_deleted_monitor_rules();--> statement-breakpoint

CREATE FUNCTION hms_private.monitor_rules(p_subject uuid,p_action text,p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
  result jsonb; target uuid; role_name text; is_owner boolean; metric public.metric_type;
  comparator_name text; threshold_name text; severity_name public.alert_severity;
  threshold_value numeric; duration_value integer; enabled_value boolean;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>4096 THEN
    RAISE EXCEPTION 'Invalid monitoring rule' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id=p_subject FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile unavailable' USING ERRCODE='42501'; END IF;

  is_owner := hms_private.is_owner(p_subject);
  IF is_owner THEN
    role_name := 'owner';
  ELSIF hms_private.can_read(p_subject,'alerts') AND EXISTS(
    SELECT 1 FROM public.caregiver_links l WHERE l.patient_id=p_subject AND l.caregiver_id=auth.uid()
      AND l.role='caregiver' AND l.status='active' AND l.revoked_at IS NULL AND 'alerts'=ANY(l.granted_scopes)
  ) THEN
    role_name := 'caregiver';
  ELSIF hms_private.can_read(p_subject,'alerts') AND EXISTS(
    SELECT 1 FROM public.doctor_patient_links l JOIN public.doctors d ON d.id=l.doctor_id JOIN public.profiles p ON p.id=d.id
      WHERE l.patient_id=p_subject AND p.auth_user_id=auth.uid() AND p.role='doctor' AND d.verified_at IS NOT NULL
        AND l.status='active' AND l.revoked_at IS NULL AND 'alerts'=ANY(l.granted_scopes)
  ) THEN
    role_name := 'doctor';
  ELSE
    RAISE EXCEPTION 'Alert monitoring access required' USING ERRCODE='42501';
  END IF;

  IF p_action='read' THEN
    SELECT jsonb_build_object('rules',coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at,x.id),'[]'::jsonb)) INTO result FROM (
      SELECT r.id,r.user_id,r.author_account_id,r.author_role,r.metric_type,r.comparator,r.threshold_type,r.value,
        r.min_duration_s,r.severity,r.enabled,r.created_at,r.updated_at,
        coalesce(p.name,CASE WHEN r.author_role='owner' THEN 'Profile owner' ELSE initcap(r.author_role) END) author_name,
        (is_owner OR r.author_account_id=auth.uid()) can_edit
      FROM public.monitoring_rules r LEFT JOIN public.profiles p ON p.auth_user_id=r.author_account_id
      WHERE r.user_id=p_subject AND r.enabled
    ) x;
  ELSIF p_action='upsert' THEN
    IF jsonb_typeof(p_payload->'value') IS DISTINCT FROM 'number'
      OR jsonb_typeof(p_payload->'duration') IS DISTINCT FROM 'number'
      OR jsonb_typeof(p_payload->'enabled') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Complete the threshold' USING ERRCODE='22023';
    END IF;
    BEGIN
      metric := (p_payload->>'metricType')::public.metric_type;
      severity_name := (p_payload->>'severity')::public.alert_severity;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Unsupported metric or severity' USING ERRCODE='22023';
    END;
    comparator_name := p_payload->>'comparator'; threshold_name := p_payload->>'thresholdType';
    threshold_value := (p_payload->>'value')::numeric; duration_value := (p_payload->>'duration')::integer;
    enabled_value := (p_payload->>'enabled')::boolean;
    IF comparator_name NOT IN ('lt','lte','gt','gte') OR threshold_name NOT IN ('absolute','baseline_deviation')
      OR metric IN ('sleep_stage','menstrual_flow')
      OR (metric='skin_temperature' AND threshold_name<>'baseline_deviation')
      OR threshold_value NOT BETWEEN 0 AND 10000 OR duration_value NOT BETWEEN 0 AND 86400
      OR (p_payload->>'duration')::numeric<>trunc((p_payload->>'duration')::numeric) THEN
      RAISE EXCEPTION 'Invalid threshold' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.monitoring_rules(user_id,author_account_id,author_role,metric_type,comparator,threshold_type,value,min_duration_s,severity,enabled)
      VALUES(p_subject,auth.uid(),role_name,metric,comparator_name,threshold_name,threshold_value,duration_value,severity_name,enabled_value)
      ON CONFLICT(user_id,author_account_id,metric_type,comparator) DO UPDATE SET
        author_role=excluded.author_role,threshold_type=excluded.threshold_type,value=excluded.value,
        min_duration_s=excluded.min_duration_s,severity=excluded.severity,enabled=excluded.enabled,updated_at=now()
      RETURNING id INTO target;
    UPDATE public.summary_jobs SET revision=revision+1,available_at=now() WHERE user_id=p_subject
      AND day >= (SELECT max(day)-1 FROM public.summary_jobs WHERE user_id=p_subject);
    result := jsonb_build_object('ok',true,'id',target);
  ELSIF p_action='remove' THEN
    target := (p_payload->>'ruleId')::uuid;
    UPDATE public.monitoring_rules SET enabled=false,updated_at=now() WHERE id=target AND user_id=p_subject
      AND (author_account_id=auth.uid() OR is_owner);
    IF NOT FOUND THEN RAISE EXCEPTION 'Rule unavailable' USING ERRCODE='42501'; END IF;
    UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL
      WHERE status='pending' AND alert_id IN (SELECT id FROM public.alerts WHERE monitoring_rule_id=target);
    result := '{"ok":true}'::jsonb;
  ELSE
    RAISE EXCEPTION 'Unknown action' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id,metadata)
    VALUES(auth.uid(),'monitor_rule_'||p_action,p_subject,'monitoring_rules',target,jsonb_build_object('author_role',role_name));
  RETURN result;
END;
$fn$;--> statement-breakpoint

CREATE FUNCTION public.hms_monitor_rules(p_subject uuid,p_action text,p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $fn$ SELECT hms_private.monitor_rules(p_subject,p_action,p_payload); $fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION hms_private.monitor_rules(uuid,text,jsonb),public.hms_monitor_rules(uuid,text,jsonb) FROM PUBLIC,anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hms_private.monitor_rules(uuid,text,jsonb),public.hms_monitor_rules(uuid,text,jsonb) TO authenticated;--> statement-breakpoint
NOTIFY pgrst,'reload schema';
