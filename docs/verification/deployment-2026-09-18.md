# Deployment and environment operations — 18 September 2026

## Production acceptance follow-up

Configured Vercel's single function region as Mumbai (`bom1`) using `vercel.json`, rather than Next.js's deprecated `preferredRegion`. This keeps compute beside the existing Mumbai database without changing providers or plans. Deployment `dpl_4d3JtqteP2QPKZqAVseaKG6RPK5B` was verified Ready with functions in `bom1` and promoted after the other task's existing test process finished.

The full deployed golden command with `HMS_DEPLOYMENT_URL=https://hms-indol-psi.vercel.app`, `HMS_DEPLOYED_ENV_FILE=.env.local`, `HMS_DEPLOYED_SUITE=golden`, and the documented `HMS_PDFTOTEXT`/`FONTCONFIG_FILE` overrides passed all eleven tests in 3.8 minutes. All original deadlines remain unchanged. The existing concurrent doctor test correction keeps injected reads unavailable until the command failure state is observed, preventing Realtime from consuming the one-shot injected failure; it also selects the intended status element.

The run began on runtime `6d228b2` and the other task promoted `f34de08` during it. Current deployment `dpl_9qcRiNTqnD8bSFDXvunWFCxEE7fo` is Ready in Mumbai; its only additional runtime change increases bounded minute-dispatch summary work. Do not present the run as a fixed-artifact latency benchmark. Scheduled HTTP calls at 20:34, 20:35 and 20:36 UTC returned 200 without timeout/error. The earlier failures below are retained as history, not the current acceptance result.

Preview remains blocked: browser sign-in succeeded but Supabase denied that account access to the existing garilohia `hms-preview` project. The founder must switch to the account with that organisation's access before server/database credentials, Storage, fixtures and the actual Preview deployment can be completed.

## Notification recovery update

The founder restored `RESEND_API_KEY` and `EMAIL_FROM`, then explicitly authorised generating replacement VAPID keys and redeploying. Generated one pair with installed `web-push` 3.6.7, validated it with `setVapidDetails`, and saved the private key as a sensitive Production-only variable. The public key and HTTPS production origin as VAPID subject are also Production-only. No private key was printed, committed or saved locally. The old pair was not recovered.

Redeployed the existing production source, preserving the other task's uncommitted test edits. Deployment `dpl_Cac6aMw5jAnoAhncfFxJHpd3dQX9` (`https://hms-brulp6jy3-gari4.vercel.app`) is Ready and serves `https://hms-indol-psi.vercel.app`. Its environment snapshot contains all five Resend/VAPID variable names. Build and `npm run check` pass (136 unit tests). Real email receipt and physical-device Web Push delivery remain unverified; no test message was sent. Existing devices should use More → Alert rules → Disable, then Enable instant alerts, because the UI otherwise reuses an existing subscription bound to the old key.

The incident notes below preserve the earlier state; notification configuration is no longer missing.

## Production

Runtime revision: `6fbe1e6`. Public origin: https://hms-indol-psi.vercel.app.
Deployment `dpl_cMrQX73mhF8BGtXXVyQ9iajeiwfm` reached Ready with restored database configuration, consent salt and cron secret. Another task subsequently changed the alias to `dpl_GLEjk1tBo3qpimszeZGuhFUJpqLz`; deployment is shared state and must be rechecked before each release claim.

`npm run build` passed (55 routes). The explicit deployed Playwright configuration uses HTTPS and no local web server. Anonymous E2E passed all nine tests. The full deployed golden suite is a separate acceptance gate, not implied by a passing build or anonymous smoke.

The anonymous suite was repeated against the final alias: all nine passed in 28.2 seconds. The authenticated run exposed summary-drain timeouts and missing/ambiguous UI status assertions (OQ016). Read-only database inspection showed no lock wait at the inspection time. A separate `.production-smoke.config.ts` process was concurrently exercising caregiver flows against the same database; it was not stopped or modified. This is not a clean isolated performance measurement.

Final authenticated result: six passed, five failed in 14.9 minutes. Passing paths: export/private documents/hard deletion, deletion retry, catalogue, wearable boundaries, attention acknowledgement/history, and Today/History/chat Realtime. Failures: caregiver and guardian summary drain deadlines; doctor snapshot confirmation; consultation injected-error status assertion; persona-b sign-in navigation timeout. Fixtures ran their cleanup blocks; there was no reported cleanup error. No failures were relabelled as passes or skipped.

## Configuration incident and recovery

The operator used `vercel env rm KEY preview --yes` to remove production credentials from Preview. Vercel CLI 59.16.0 deleted the entire shared variable record, including Production targets, rather than detaching only Preview. This was an operator error; existing deployment snapshots must not be assumed to preserve recovery access to deleted values.

- Restored Production `DATABASE_URL`, `DIRECT_URL` and `SUPABASE_SECRET_KEY` from the existing local configuration. Restored Development `DIRECT_URL` separately.
- Replaced Production `CONSENT_IP_SALT` and `CRON_SECRET` with freshly generated values. Stored the matching cron secret in restricted Supabase Vault and redeployed. No credentials were printed or committed.
- Still missing: Production `RESEND_API_KEY`, `EMAIL_FROM`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Founder restoration through Vercel settings and another deployment are required. Email/push delivery must not be claimed while absent. Preserve the original VAPID pair if possible, because existing subscriptions depend on it.
- The unused legacy `FITBIT_CLIENT_ID` was removed too. Current provider connections use Google Health/WHOOP configuration instead.
- Public Production Supabase settings and application origin were not removed. No patient records were copied or deleted by the environment changes.

For future shared records, inspect targets and update the target list through the API while preserving the value. Do not use `env rm` to detach a target from a multi-target record. Keep credentials in separate environment-specific records.

## Minute dispatcher

`npm run cron:setup` activated `hms-minute-dispatch` on `* * * * *`. Vault access by `anon` and `authenticated` was checked as denied. Vercel cron definitions were empty, avoiding duplicate dispatchers. A direct unauthorised POST returned 401; a Vault-authenticated POST returned 200 and completed three summary jobs without failures.

Both `cron.job_run_details` and `net._http_response` were inspected. Calls at 20:08 and 20:09 UTC on 17 September returned 200 without timeout/error. A 20:10 call returned 401 during concurrent deployment; the 20:11 call returned 200. Do not equate the cron SQL status `succeeded` with HTTP success. Notifications remain a separate acceptance gate.

Follow-up: 20:11, 20:12 and 20:13 UTC calls all returned 200 with no timeout/error. The current Ready alias was verified at runtime commit `6fbe1e64a3c8686f5b9da72adb0d5cc46a328110`.

## Isolated Preview

Founder authorised the existing garilohia organisation only if free. The quoted and confirmed project price was $0/month. Created `hms-preview`, ref `eqrlycvveqfypalipssq`, in Mumbai. Applied the existing 41 Drizzle migrations, recorded their original hashes/timestamps in the Drizzle ledger, and copied only the 25 public device catalogue entries. Verified zero profiles, zero metrics and zero public tables without RLS.

Vercel Preview now has the new project's public URL/publishable key and an independent consent salt. It has no production database credentials. The server key and database password are not exposed by the connected tools; the Supabase dashboard requires founder sign-in. Storage, synthetic fixtures, redirect/origin configuration and the actual Preview deployment remain incomplete. No production data fallback is acceptable.

The Supabase security advisor reported six informational [RLS enabled without policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) notices for the existing server-only queues/configuration tables. It reported no warning/error findings. Do not add permissive client policies to silence these deny-by-default notices.

## Reproducible deployed checks

```sh
HMS_DEPLOYMENT_URL=https://hms-indol-psi.vercel.app npx playwright test --config playwright.deployed.config.ts
HMS_DEPLOYMENT_URL=https://hms-indol-psi.vercel.app HMS_DEPLOYED_ENV_FILE=.env.local HMS_DEPLOYED_SUITE=golden npx playwright test --config playwright.deployed.config.ts
```

For Preview, use a separate gitignored staging environment file; never `.env.local` with production credentials. Golden tests create and clean synthetic accounts and records, and require the documented Poppler configuration for guardian PDF extraction. Do not run simultaneous full suites against the same live database while assessing latency.
