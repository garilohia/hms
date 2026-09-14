-- CI-only auth schema fixture for PostgreSQL RLS tests. Live Auth is verified separately.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}', raw_app_meta_data jsonb DEFAULT '{}',
  aud text, role text, created_at timestamptz, updated_at timestamptz, deleted_at timestamptz, banned_until timestamptz,
  email_confirmed_at timestamptz
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- Minimal provider-owned table needed to replay the application's restrictive
-- document-bucket policy. This does not simulate Storage uploads or object APIs;
-- those are verified separately against Supabase by the live golden path.
CREATE SCHEMA storage;
CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text NOT NULL, name text NOT NULL);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

-- Minimal provider-owned realtime fixture. Migrations 0024, 0026 and 0040 attach broadcast
-- authorisation policies to realtime.messages and send pings through realtime.send, so the
-- objects must exist for a from-scratch migration replay. This does not simulate the
-- Realtime server, websocket transport or delivery; those remain unverified (OQ015).
CREATE SCHEMA realtime;
CREATE TABLE realtime.messages (
  id bigserial PRIMARY KEY, topic text NOT NULL, extension text NOT NULL,
  event text, payload jsonb, private boolean DEFAULT false,
  inserted_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
-- Supabase resolves the subscribed channel through this function; the policies call it.
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('realtime.topic', true), '');
$f$;
-- Deliberately inert. The broadcast triggers fire on metrics, alerts and daily_summaries,
-- so anything that can raise here would fail unrelated tests. A future test that wants to
-- assert a broadcast was queued should make this insert into realtime.messages instead.
CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $f$ BEGIN RETURN; END; $f$;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON realtime.messages TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE realtime.messages_id_seq TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION realtime.topic() TO anon, authenticated, service_role;
