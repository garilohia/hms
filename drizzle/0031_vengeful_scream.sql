ALTER TABLE "monitoring_rules" ADD CONSTRAINT "monitoring_rule_metric_bounds" CHECK (("monitoring_rules"."threshold_type" = 'baseline_deviation' AND "monitoring_rules"."value" BETWEEN 0.1 AND 20) OR ("monitoring_rules"."threshold_type" = 'absolute' AND CASE "monitoring_rules"."metric_type"
    WHEN 'spo2' THEN "monitoring_rules"."value" BETWEEN 50 AND 100 WHEN 'heart_rate' THEN "monitoring_rules"."value" BETWEEN 20 AND 300
    WHEN 'resting_heart_rate' THEN "monitoring_rules"."value" BETWEEN 20 AND 220 WHEN 'hrv_rmssd' THEN "monitoring_rules"."value" BETWEEN 0 AND 1000
    WHEN 'respiratory_rate' THEN "monitoring_rules"."value" BETWEEN 1 AND 100 WHEN 'steps' THEN "monitoring_rules"."value" BETWEEN 0 AND 200000
    WHEN 'active_calories' THEN "monitoring_rules"."value" BETWEEN 0 AND 50000 WHEN 'total_calories' THEN "monitoring_rules"."value" BETWEEN 0 AND 50000
    WHEN 'sleep_duration' THEN "monitoring_rules"."value" BETWEEN 0 AND 1440 WHEN 'stress_score' THEN "monitoring_rules"."value" BETWEEN 0 AND 100
    WHEN 'weight_kg' THEN "monitoring_rules"."value" BETWEEN 0.5 AND 500 WHEN 'body_fat_pct' THEN "monitoring_rules"."value" BETWEEN 1 AND 75
    WHEN 'blood_pressure_systolic' THEN "monitoring_rules"."value" BETWEEN 30 AND 300 WHEN 'blood_pressure_diastolic' THEN "monitoring_rules"."value" BETWEEN 20 AND 200
    WHEN 'blood_glucose' THEN "monitoring_rules"."value" BETWEEN 20 AND 1000 WHEN 'vo2max' THEN "monitoring_rules"."value" BETWEEN 1 AND 100
    WHEN 'basal_body_temperature' THEN "monitoring_rules"."value" BETWEEN 30 AND 45 ELSE false END));--> statement-breakpoint

CREATE FUNCTION hms_private.cancel_changed_monitor_rule_deliveries() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF ROW(OLD.threshold_type,OLD.value,OLD.min_duration_s,OLD.severity,OLD.enabled)
    IS DISTINCT FROM ROW(NEW.threshold_type,NEW.value,NEW.min_duration_s,NEW.severity,NEW.enabled) THEN
    UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL,last_error='MonitoringRuleChanged'
      WHERE status='pending' AND alert_id IN (SELECT id FROM public.alerts WHERE monitoring_rule_id=NEW.id);
  END IF;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint
CREATE TRIGGER cancel_changed_monitor_rule_deliveries AFTER UPDATE OF threshold_type,value,min_duration_s,severity,enabled ON public.monitoring_rules
FOR EACH ROW EXECUTE FUNCTION hms_private.cancel_changed_monitor_rule_deliveries();--> statement-breakpoint

CREATE FUNCTION hms_private.monitor_delivery_status(p_subject uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE actor uuid:=auth.uid(); owner_id uuid; owns boolean; result jsonb;
BEGIN
  IF NOT hms_private.can_read(p_subject,'alerts') THEN RAISE EXCEPTION 'Alert access required' USING ERRCODE='42501'; END IF;
  SELECT owner_account_id INTO owner_id FROM public.profiles WHERE id=p_subject;
  owns:=hms_private.is_owner(p_subject);
  SELECT jsonb_build_object(
    'channels',jsonb_build_array(jsonb_build_object(
      'recipient','Profile owner','is_current',owner_id=actor,
      'email_enabled',EXISTS(SELECT 1 FROM public.consents WHERE user_id=p_subject AND consent_type='alert_email' AND revoked_at IS NULL),
      'push_enabled',EXISTS(SELECT 1 FROM hms_private.push_subscriptions WHERE account_id=owner_id)
    )) || CASE WHEN owner_id<>actor THEN jsonb_build_array(jsonb_build_object(
      'recipient','You','is_current',true,
      'email_enabled',EXISTS(SELECT 1 FROM public.profiles p JOIN public.consents c ON c.user_id=p.id WHERE p.auth_user_id=actor AND c.consent_type='alert_email' AND c.revoked_at IS NULL),
      'push_enabled',EXISTS(SELECT 1 FROM hms_private.push_subscriptions WHERE account_id=actor)
    )) ELSE '[]'::jsonb END,
    'activity',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.fired_at DESC,x.id DESC) FROM (
      SELECT a.id,a.fired_at,a.severity,a.acknowledged_at,a.is_historical,a.is_sample,a.metric_snapshot->>'body' body,
        coalesce((SELECT jsonb_agg(jsonb_build_object(
          'recipient',CASE WHEN d.recipient_kind='owner' THEN 'Profile owner' WHEN d.recipient_key=actor::text THEN 'You'
            WHEN d.recipient_kind='contact' THEN 'Emergency contact' ELSE coalesce(rp.name,initcap(d.recipient_kind)) END,
          'channel',d.channel,'status',d.status,'delivered_at',d.delivered_at) ORDER BY d.created_at,d.id)
          FROM public.alert_deliveries d
          LEFT JOIN public.profiles rp ON rp.auth_user_id=CASE WHEN d.recipient_kind='contact' THEN NULL ELSE d.recipient_key::uuid END
          WHERE d.alert_id=a.id AND (owns OR d.recipient_kind='owner' OR d.recipient_key=actor::text)),'[]'::jsonb) deliveries
      FROM public.alerts a WHERE a.user_id=p_subject ORDER BY a.fired_at DESC,a.id DESC LIMIT 25
    ) x),'[]'::jsonb)
  ) INTO result;
  IF NOT hms_private.is_self(p_subject) THEN
    INSERT INTO public.audit_log(actor_id,action,target_user_id,target_table,target_id)
      VALUES(actor,'shared_read',p_subject,'alert_delivery_activity',p_subject);
  END IF;
  RETURN result;
END;
$fn$;--> statement-breakpoint

CREATE FUNCTION public.hms_monitor_delivery_status(p_subject uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $fn$ SELECT hms_private.monitor_delivery_status(p_subject); $fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION hms_private.monitor_delivery_status(uuid),public.hms_monitor_delivery_status(uuid) FROM PUBLIC,anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hms_private.monitor_delivery_status(uuid),public.hms_monitor_delivery_status(uuid) TO authenticated;--> statement-breakpoint
NOTIFY pgrst,'reload schema';
