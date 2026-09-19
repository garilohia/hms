# Draft for the project owner — not sent

Subject: Supported pg_net ACL hardening and extension-schema advisor exception

Project: HMS Production, `xopmvfibmsqycwwqmiir`, Mumbai.

We use Supabase pg_cron and pg_net for a one-minute call to our authenticated
Vercel dispatcher. A read-only audit on 19 September 2026 found:

- `pg_net` version 0.20.4 is owned by `supabase_admin`, has extension metadata in
  `public`, is non-relocatable, and has 28 members in `net`.
- Security Advisor flags the extension's public-schema metadata.
- `net` is excluded from PostgREST. A zero-row `Accept-Profile: net` request
  returned 406/PGRST106; we did not read queue rows or request headers.
- `PUBLIC` SQL grants provide `anon`/`authenticated` with net schema/table/function
  access. The queue/response tables have no RLS. API exclusion does not remove
  those underlying SQL privileges.
- Both the pg_net worker and `hms-minute-dispatch` cron job run as `postgres`.
  That role currently relies on inherited grants and lacks the extension owner's
  schema grant option. We have not changed grants, edited catalogues, or
  dropped/recreated the extension.

Please confirm:

1. Is the schema warning an expected exception for this managed non-relocatable
   extension, or is there a supported migration/upgrade path?
2. What owner-level least-privilege procedure removes unnecessary browser/PUBLIC
   access while explicitly preserving the postgres worker, cron and any required
   managed webhook roles?
3. Will extension upgrades restore broad grants, and how should we verify the
   desired permissions after upgrades?

We will verify queue processing, scheduled HTTP responses and managed webhook
behaviour after any approved change. No API key, database URL, Vault value,
queued header or health record is included in this request.
