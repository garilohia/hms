# External readiness follow-up — 19 September 2026

## Changes

- Google Health: intraday heart-rate normalisation, corrected VO₂ max scope, daily-date filtering, and seven-day late-arrival reconciliation.
- Google Health/WHOOP: frozen, resumable page checkpoints. Page persistence precedes checkpoint advancement; replay deduplicates. The sync-through timestamp records the completed window, not the time an old sweep finally finishes.
- Disconnect: stop local ingestion immediately, attempt vendor revocation with a bounded deadline, retain encrypted credentials only for retry on uncertainty, and expose explicit manual-provider-removal recovery. Stale work cannot mutate a changed or disconnected grant.
- OAuth: request only implemented scopes; queue the first sync rather than blocking the callback on a backfill. Token exchange shares a 20-second network deadline.
- Notification readiness: redacted local/provider-metadata checker plus a cron-authenticated deployed configuration diagnostic. Diagnostic requests perform no dispatch and invalid/duplicate check parameters fail closed.
- Added provider setup and notification-acceptance runbooks. No accounts, provider applications, terms, paid plans or real test messages were created.

## Infrastructure

- Generated the previously absent production `INTEGRATION_TOKEN_KEY` after verifying zero provider connections. Stored it as sensitive in Vercel Production only; no secret value was printed or written into source control. Provider client credentials remain absent.
- Applied `0041_integration_sync_checkpoint` through the repository migrator to Production and through the connected migration API, with the matching Drizzle ledger record, to isolated Preview.
- Both databases have 42 migrations. The checkpoint column is JSONB, forced RLS remains enabled on the private table, and neither `anon` nor `authenticated` has table-read privilege. Preview still has zero profiles, metrics and provider connections; no production health data was copied.
- Existing production minute calls at 09:35–09:37 UTC returned HTTP 200. These pre-deployment observations do not verify the new code.
- Preview browser access is still blocked: the signed-in account exposes a different organisation. Its server/database credentials, Storage, synthetic seeding, redirects/origin and deployed acceptance remain unfinished.

## Verification

- `npm run check`: lint, strict TypeScript, both-mode contrast checks and 210 unit tests pass.
- `npm run build`: passes, 55 routes.
- `git diff --check`: passes.
- A first baseline database run passed all 98 existing tests. Added real-database tests exposed JSONB double encoding; the early 101-test run had 100 passes and one failure. Serialised metadata, metric batches and checkpoints now explicitly bind as text before JSONB conversion. A concurrent targeted fixture run hit its existing 120-second setup timeout; it is not counted as passed.
- Final `npm run db:verify`: all 102 tests pass in 178.69 seconds, including checkpoint isolation/CAS and the real normalised-page ingestion regression. No tests were skipped.
- Production Supabase security advisor reports two warnings: non-relocatable managed `pg_net` extension metadata in `public`, and leaked-password protection disabled. Both databases also have six intentional deny-by-default RLS/no-policy informational notices. Do not describe the advisor as clean. Review [extension guidance](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public) and [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). No extension was moved/dropped and no paid Auth setting was enabled.
- Deployed results are recorded below only after completion.

## Hosted verification

- Pushed runtime commit `0ce788b80ff79fcddee358cba17f0cdd3cee6e88`. GitHub Actions run `35435895928` passed both quality and from-scratch database jobs.
- Remote production build completed in 28.578 seconds. Deployment `dpl_CJniHaw9HhqUcMPHY1PSQfgr87S6` is Ready, Next.js 16.3.4, function region `bom1`. Promoted it and verified the production alias `https://hms-indol-psi.vercel.app` resolves to that deployment/commit.
- `HMS_DEPLOYMENT_URL=https://hms-indol-psi.vercel.app npx playwright test --config playwright.deployed.config.ts`: all nine public/boundary tests pass in 1.5 minutes.
- Authenticated runtime `check=notifications` returned HTTP 200 with zero notifications sent: VAPID pair and contact pass, Resend key syntax passes, sender fails. Production's available sender configuration is Resend's test sender; an owner's verified sending domain/address is still required. Domain permissions, inbox and physical-device receipt remain unverified.
- Managed-extension audit: `pg_net` is non-relocatable/managed and not exposed by PostgREST (zero-row probe 406/PGRST106). Its inherited SQL ACLs need supported owner-level hardening, not a blanket revoke that could break the postgres worker/cron. See OQ017. No extension or grant changes were made.
- The first full signed-in run on `0ce788b` finished with eight passes and three failures in 10.7 minutes: doctor/guardian snapshot confirmations stayed empty; patient onboarding encountered a browser `/api/consents` timeout. No test deadlines were relaxed. Error-level deployment logs contained no matching exception, and the bounded consent-route log sample contained nine 200s plus the expected unauthorised/forbidden probes; these observations do not establish the timeout's cause.

## Summary interaction follow-up

- D040 keeps snapshot/range/medication controls disabled until hydration. PDF navigation, clinical calculations, permissions and existing copy are unchanged.
- Added a script-gated doctor regression that checks the initial disabled controls before releasing JavaScript, then runs the original snapshot, real-PDF and audited-scope assertions.
- `HMS_TEST_PORT=3112 npm run golden:verify -- doctor.spec.ts --grep 'golden 3' --output test-results/summary-hydration-green`: one pass in 15.5 seconds on the fixed local production build.
- The first old-deployment script-gated attempt hit a cleanup-order error (`Route is already handled`) and is not valid red proof. The test now drains held continuations before removing interception. Final deployed verification follows after release.
- Corrected deterministic red run against the unchanged `0ce788b` deployment: one failure in 57.4 seconds, specifically expected disabled/received enabled for Save current summary snapshot while scripts were held. Cleanup succeeded. Together with the local green result, this confirms the pre-hydration interaction regression without extending timeouts.

## Remaining launch gates

Real sender-domain/inbox and physical-device push acceptance; Supabase SMTP/magic-link email receipt; isolated Preview completion; real provider application approval, client credentials, expiry/revocation and device-delay acceptance; clinician/legal sign-off; compiled native clients and physical-device acceptance remain outstanding. The latter stays outside this web implementation scope.

OQ017's supported pg_net privilege-hardening decision and password-auth exposure review remain security gates; the drafted support request has not been sent.

Dense seven-day reconciliation can take many ticks. Fair fresh/reconciliation lanes, per-user/metric capacity, provider quotas and load tests are still required before advertising minute-level wearable delivery. Passing the tests above is not clinical approval or evidence of a live wearable service level.
