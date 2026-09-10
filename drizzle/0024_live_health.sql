-- Custom SQL migration file, put your code below! --
ALTER TABLE hms_private.integration_connections ADD COLUMN sync_locked_until timestamptz;
ALTER TABLE hms_private.integration_connections ADD COLUMN next_sync_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX integration_connections_due_idx ON hms_private.integration_connections(next_sync_at,sync_locked_until);

CREATE TABLE "hms_private"."push_subscriptions" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL UNIQUE,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "push_endpoint_length" CHECK (length(endpoint) BETWEEN 16 AND 4096),
  CONSTRAINT "push_key_lengths" CHECK (length(p256dh) BETWEEN 16 AND 512 AND length(auth) BETWEEN 8 AND 256)
);--> statement-breakpoint
CREATE INDEX "push_subscriptions_account_idx" ON "hms_private"."push_subscriptions" ("account_id");--> statement-breakpoint
REVOKE ALL ON "hms_private"."push_subscriptions" FROM PUBLIC, anon, authenticated;--> statement-breakpoint

CREATE OR REPLACE FUNCTION hms_private.can_receive_patient_live(p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $fn$
  SELECT hms_private.actor_is_live() AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id=p_subject AND (
      p.owner_account_id=(SELECT auth.uid()) OR p.auth_user_id=(SELECT auth.uid()) OR
      EXISTS(SELECT 1 FROM public.caregiver_links l WHERE l.patient_id=p.id AND l.caregiver_id=(SELECT auth.uid()) AND l.status='active' AND l.revoked_at IS NULL AND 'alerts'=ANY(l.granted_scopes)) OR
      EXISTS(SELECT 1 FROM public.doctor_patient_links l JOIN public.doctors d ON d.id=l.doctor_id JOIN public.profiles dp ON dp.id=d.id WHERE l.patient_id=p.id AND dp.auth_user_id=(SELECT auth.uid()) AND d.verified_at IS NOT NULL AND l.status='active' AND l.revoked_at IS NULL AND 'alerts'=ANY(l.granted_scopes))
    ) AND (p.owner_account_id=(SELECT auth.uid()) OR EXISTS(SELECT 1 FROM public.consents c WHERE c.user_id=p.id AND c.consent_type='doctor_sharing' AND c.revoked_at IS NULL))
  );
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION hms_private.can_receive_patient_live(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION hms_private.can_receive_patient_live(uuid) TO authenticated;

DROP POLICY IF EXISTS "hms patient change broadcasts" ON realtime.messages;
CREATE POLICY "hms patient change broadcasts" ON realtime.messages FOR SELECT TO authenticated
USING (
  realtime.messages.extension='broadcast' AND
  (SELECT realtime.topic()) ~ '^patient:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
  hms_private.can_receive_patient_live(substring((SELECT realtime.topic()) from 9)::uuid)
);--> statement-breakpoint

CREATE FUNCTION hms_private.broadcast_patient_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE subject uuid := coalesce(NEW.user_id,OLD.user_id);
BEGIN
  PERFORM realtime.send('{"changed":true}'::jsonb,'changed','patient:'||subject::text,true);
  RETURN NULL;
END;
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION hms_private.broadcast_patient_change() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER hms_alert_live AFTER INSERT OR UPDATE OR DELETE ON public.alerts FOR EACH ROW EXECUTE FUNCTION hms_private.broadcast_patient_change();
CREATE TRIGGER hms_summary_live AFTER INSERT OR UPDATE OR DELETE ON public.daily_summaries FOR EACH ROW EXECUTE FUNCTION hms_private.broadcast_patient_change();
CREATE TRIGGER hms_source_live AFTER INSERT OR UPDATE OR DELETE ON public.data_sources FOR EACH ROW EXECUTE FUNCTION hms_private.broadcast_patient_change();
