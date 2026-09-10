-- Relationship and consent revocation must retire monitor-authored rules immediately.
CREATE FUNCTION hms_private.retire_monitor_rules_on_access_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE subject uuid; author uuid; author_kind text; lost_access boolean:=false;
BEGIN
  IF TG_TABLE_NAME='caregiver_links' THEN
    subject:=OLD.patient_id; author:=OLD.caregiver_id; author_kind:='caregiver';
    lost_access:=OLD.role='caregiver' AND OLD.status='active' AND OLD.revoked_at IS NULL AND 'alerts'=ANY(OLD.granted_scopes)
      AND (TG_OP='DELETE' OR NEW.role<>'caregiver' OR NEW.status<>'active' OR NEW.revoked_at IS NOT NULL OR NOT ('alerts'=ANY(NEW.granted_scopes)));
  ELSIF TG_TABLE_NAME='doctor_patient_links' THEN
    subject:=OLD.patient_id; author_kind:='doctor';
    SELECT p.auth_user_id INTO author FROM public.profiles p WHERE p.id=OLD.doctor_id;
    lost_access:=OLD.status='active' AND OLD.revoked_at IS NULL AND 'alerts'=ANY(OLD.granted_scopes)
      AND (TG_OP='DELETE' OR NEW.status<>'active' OR NEW.revoked_at IS NOT NULL OR NOT ('alerts'=ANY(NEW.granted_scopes)));
  ELSE
    subject:=OLD.user_id;
    lost_access:=OLD.consent_type='doctor_sharing' AND OLD.revoked_at IS NULL
      AND (TG_OP='DELETE' OR NEW.revoked_at IS NOT NULL);
  END IF;
  IF lost_access THEN
    UPDATE public.monitoring_rules SET enabled=false,updated_at=now()
      WHERE user_id=subject AND author_role<>'owner' AND (author IS NULL OR (author_account_id=author AND author_role=author_kind));
    UPDATE public.alert_deliveries SET status='cancelled',lease_token=NULL,locked_until=NULL,last_error='MonitoringAccessRevoked'
      WHERE status='pending' AND alert_id IN (
        SELECT a.id FROM public.alerts a JOIN public.monitoring_rules r ON r.id=a.monitoring_rule_id
        WHERE a.user_id=subject AND NOT r.enabled
      );
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint

CREATE TRIGGER retire_caregiver_monitor_rules AFTER UPDATE OR DELETE ON public.caregiver_links
FOR EACH ROW EXECUTE FUNCTION hms_private.retire_monitor_rules_on_access_change();--> statement-breakpoint
CREATE TRIGGER retire_doctor_monitor_rules AFTER UPDATE OR DELETE ON public.doctor_patient_links
FOR EACH ROW EXECUTE FUNCTION hms_private.retire_monitor_rules_on_access_change();--> statement-breakpoint
CREATE TRIGGER retire_shared_monitor_rules AFTER UPDATE OR DELETE ON public.consents
FOR EACH ROW EXECUTE FUNCTION hms_private.retire_monitor_rules_on_access_change();
