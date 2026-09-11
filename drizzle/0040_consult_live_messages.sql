-- Consultation chat becomes live. The participant rule is exactly the one
-- hms_private.consult_read already enforces: the owning patient side, or the
-- consult's verified doctor. Only a "changed" ping is broadcast; no clinical
-- text crosses the realtime channel, so authorisation is re-checked on the read.
CREATE OR REPLACE FUNCTION hms_private.can_receive_consult_live(p_consult uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
  SELECT hms_private.actor_is_live() AND EXISTS(
    SELECT 1 FROM public.consults c WHERE c.id=p_consult
      AND (hms_private.is_owner(c.patient_id) OR hms_private.is_consult_doctor(c.patient_id,c.doctor_id)));
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION hms_private.can_receive_consult_live(uuid) FROM PUBLIC,anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hms_private.can_receive_consult_live(uuid) TO authenticated;--> statement-breakpoint

DROP POLICY IF EXISTS "hms consult change broadcasts" ON realtime.messages;--> statement-breakpoint
CREATE POLICY "hms consult change broadcasts" ON realtime.messages FOR SELECT TO authenticated
USING (
  realtime.messages.extension='broadcast' AND
  (SELECT realtime.topic()) ~ '^consult:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
  hms_private.can_receive_consult_live(substring((SELECT realtime.topic()) from 9)::uuid)
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION hms_private.broadcast_consult_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE thread uuid := coalesce(NEW.consult_id,OLD.consult_id);
BEGIN
  PERFORM realtime.send('{"changed":true}'::jsonb,'changed','consult:'||thread::text,true);
  RETURN NULL;
END;
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION hms_private.broadcast_consult_change() FROM PUBLIC,anon,authenticated;--> statement-breakpoint
DROP TRIGGER IF EXISTS hms_message_live ON public.messages;--> statement-breakpoint
CREATE TRIGGER hms_message_live AFTER INSERT OR UPDATE OR DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION hms_private.broadcast_consult_change();--> statement-breakpoint

CREATE OR REPLACE FUNCTION hms_private.broadcast_consult_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  PERFORM realtime.send('{"changed":true}'::jsonb,'changed','consult:'||coalesce(NEW.id,OLD.id)::text,true);
  RETURN NULL;
END;
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION hms_private.broadcast_consult_row() FROM PUBLIC,anon,authenticated;--> statement-breakpoint
DROP TRIGGER IF EXISTS hms_consult_live ON public.consults;--> statement-breakpoint
CREATE TRIGGER hms_consult_live AFTER INSERT OR UPDATE OR DELETE ON public.consults FOR EACH ROW EXECUTE FUNCTION hms_private.broadcast_consult_row();
