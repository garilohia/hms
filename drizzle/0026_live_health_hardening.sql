DROP INDEX IF EXISTS hms_private.integration_connections_due_idx;
CREATE INDEX integration_connections_due_idx ON hms_private.integration_connections(next_sync_at,sync_locked_until);
DROP POLICY IF EXISTS "hms patient change broadcasts" ON realtime.messages;
CREATE POLICY "hms patient change broadcasts" ON realtime.messages FOR SELECT TO authenticated
USING (
  realtime.messages.extension='broadcast' AND
  (SELECT realtime.topic()) ~ '^patient:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND
  hms_private.can_receive_patient_live(substring((SELECT realtime.topic()) from 9)::uuid)
);
