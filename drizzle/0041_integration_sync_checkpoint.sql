-- Private provider cursors let a bounded worker resume dense health histories.
-- Existing forced RLS and revoked browser-role grants remain in force.
ALTER TABLE hms_private.integration_connections ADD COLUMN sync_checkpoint jsonb;
