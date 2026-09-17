# HMS build handoff — 10 September 2026

## Status: M0–M8 complete; native server foundation added

All nine original milestones are implemented. Subsequent work adds versioned native ingestion, bearer-token authentication, immutable retry receipts, measured latency/freshness, timezone re-bucketing and verified private Realtime invalidations. It does not claim signed native binaries, vendor approval, a supervised pilot or clinical/legal approval.

The original large streaming-import and shorter verification matrix evidence remains below. The linked Vercel project and production site now exist at `https://hms-indol-psi.vercel.app`, but Preview does not yet have deliberate public Supabase configuration. Staging must not silently use production health data.

## What works

1. The existing Next.js 16.3.4 App Router scaffold, strict TypeScript, Tailwind, npm lockfile and Supabase SSR helpers are retained. The nonexistent-todos demo is removed. Public/secret Supabase key names match the supplied project.
2. Adult magic-link authentication, database-enforced minor signup rejection, guardian-owned dependent profiles, consent provenance, RLS on all 23 application tables and audited non-self reads are implemented.
3. Three deterministic, labelled 90-day sample personas, generic CSV and streaming Apple Health ZIP imports use the common normalisation layer. The browser Web Worker sends bounded batches; no server function receives the archive.
4. Pure, tested analytics produce local-day summaries, 28-day median/MAD baselines, explainable readiness, cycle estimates and non-diagnostic insights. Durable database jobs support recomputation and retry protection.
5. All default alert rules, exact unusual-reading copy, acknowledgement, consented escalation deadlines, outbox retries and protected minute-dispatch routes are implemented. Local Chrome notification and console-stub delivery are verified.
6. Three patient tabs—Today, Doctors and History—work at 390 px. More holds configuration, imports, raw history, cycle opt-in, data rights, devices and legal pages. Chrome PWA installability is verified; health data is not cached offline.
7. Doctor registration/verification boundaries, scoped sharing, consultation requests, scheduling, messages, closing notes and immutable 30/90-day clinical summaries/PDFs work. Caregiver invitation, acceptance, read-only access and revocation are audited.
8. Guardian consent is displayed on summaries/PDFs. Explicit conversion at 18 preserves the health-profile ID and history, requires the receiving adult's consent, and retires mandatory guardian authority. Existing recipient history is not merged or overwritten.
9. Private original documents, streamed account ZIP export and retryable hard deletion work end to end. Export covers owned profiles, not merely linked patients. Deleting a doctor preserves other patients' consultation history with anonymised references.
10. A 25-device, manufacturer-sourced catalogue has dated prices/specifications and honest unknowns. It held 20 rows at M7/M8 and was extended to 25 during the post-M8 wearable-coverage pass (D016); PROGRESS.md's M7 entry records the earlier count as history. Public legal previews and manually requested pharmacy search links are implemented without partner accounts, orders or implied integrations.

## M8 corrections

- Lost-response fault injection reproduced two consultations from one intended request. The UI now reuses an in-memory ID for unchanged retries, using the database's existing idempotency checks. Messages clear on confirmed save even if the following refresh fails. Browser regressions assert one consultation and exactly two messages after injected failures.
- Doctor-page and care-API pagination cursors now require complete UUID/timestamp shapes. Malformed URL values return a controlled not-found page; malformed API cursors return 400. Microsecond timestamp strings are preserved.
- The environment template no longer suggests that VAPID keys alone enable the unimplemented server-push transport.
- The live import test has progress reporting, a two-minute no-progress watchdog, fifteen minutes per import and a 35-minute overall envelope (D019). The previous undocumented 400-second allowance and an initial ten-minute replacement both expired during healthy, progressing re-imports. The ≥200 MiB file, ≤512 MiB memory, batch, worker, row-count and deduplication assertions are unchanged; production deadlines are unchanged.

The requested whole-repository `codex review` completed and reported no actionable findings. Independent regression work found the issues above; that review result is not a correctness guarantee. Details are in `docs/verification/m8-review.md`.

## Verification evidence

These are actual passing commands on the M8 worktree. The large-import command passed twice in one run, and every command in the shorter matrix passed in each of two complete sequential runs. Local tooling is Node 26.8.1, npm 11.19.0 and Playwright 1.63.0; Node 24 is the configured CI/deployment target. Hosted CI and physical-device testing are not claimed.

| Command | Verified result |
|---|---|
| `npm run check` | Lint, strict typecheck and 112 unit tests pass repeatedly. |
| `npm run build` | Production build passes; 47 routes. |
| `npm run db:verify` | Full, unfiltered 87-test migration/RLS suite passes, including all 23 tables. An earlier timeout and its focused diagnostic rerun are separately recorded in PROGRESS.md. |
| `npm run db:advisors` | No reported issues. This is not an external penetration test. |
| `npm run storage:setup` | Private PDF/JPEG/PNG bucket, 3 MiB limit and application-route-only access verified. |
| `npm run seed` | 22,700 existing sample readings deduplicate; fictional doctors and 20 catalogue entries verified. |
| `npm run summaries:recompute` / `npm run summaries:verify` | 90 stored days and 13 baselines per persona; readiness 100/100/55; no pending sample jobs. |
| `npm run e2e` | Eight anonymous/boundary/legal/pharmacy browser tests pass. |
| `npm run auth:verify` | Real synthetic magic-link redemption, guardian consent and sign-out pass; no inbox-delivery claim. |
| `npm run alerts:verify` | Live synthetic alert/cron/acknowledgement/local-notification flow passes. |
| `npm run golden:verify` | All nine tests, covering all seven required paths plus deletion recovery and the live catalogue, passed in both final matrix runs (7.3 and 7.0 minutes). |
| `npm run pdf:verify` | Six one-page persona/guardian/Unicode/width fixtures pass. Guardian and multilingual renders were visually rechecked; the renderer/layout is unchanged from M6's six-fixture visual review. |
| `npm audit --omit=dev` | Zero production dependency vulnerabilities reported. |
| `git diff --check` | Passes. |
| `npm run ingestion:verify -- --repeat-each=2` | Two complete tests passed in 36.7 minutes. Each generated 220,201,254 XML bytes and 620,285 records, inserted 6,000 distinct rows then zero on re-import, used 1,243 bounded batches/three workers and stayed below 512 MiB RSS. |

### Post-M8 native/freshness verification — 10 September 2026

- `npm run check`: lint, strict typecheck and 132 unit tests pass.
- `npm run build`: production build passes with 54 routes.
- `npm run db:verify`: all 91 migration, RLS, native replay and latency-report tests pass.
- `npm run db:advisors`: no issues reported.
- `npm run e2e`: all nine public/boundary/legal browser tests pass.
- `npm run auth:verify`: both live Supabase auth tests pass, including bearer bootstrap, source registration and immutable batch retry.
- `npm run alerts:verify`: the protected minute job, alert acknowledgement/settings and local notification path pass.
- The local signed-in latency dashboard was visually checked at 390 px. Native physical-device and production notification/provider tests remain launch gates.
- Re-confirmed on 11 September 2026 on `big-changes` at `9b75abd`: `npm run check` (132 unit tests) and `npm run build` (54 routes) pass, and the working tree is clean. The database, live-browser, golden, PDF and large-import suites were not re-executed on that date; their evidence is the 10 September run above.
- The device catalogue was extended from 20 to 25 manufacturer-sourced rows in this pass, adding connection-path, update-class and expected-delay fields per D016 and D024.

The two final import reports are retained in `docs/verification/m8-ingestion.json`. Their first/second test durations were 559,484/555,669 ms and 528,488/532,773 ms; peak renderer RSS was 194,609,152 and 236,044,288 bytes. Earlier host-sleep interruptions and deadline failures are accurately retained in PROGRESS.md and are not counted. Their exact synthetic fixtures were removed and checked absent; seeded samples remain intentionally.

## Cuts and known limitations

- Vendor-specific Fitbit/Garmin/WHOOP/Oura/Withings connectors are not shipped. The versioned HealthKit/Health Connect server contract and acceptance documents exist, but compiled companions, encrypted device queues, APNs/FCM credentials and physical-device verification remain pending. Catalogue features do not imply HMS import compatibility; Apple HRV SDNN is not relabelled RMSSD.
- A public Vercel production site and green hosted GitHub Actions runs now exist. The minute scheduler and real notification inbox/device delivery are not yet verified. No third-party partnership or order was created. SMTP/redirect, cron and notification launch checks remain OQ003–OQ004.
- Doctors in the seed are fictional Sample data. Real credential checks and clinician onboarding must precede clinical use. Chat updates through private Realtime Broadcast and retains explicit Refresh as a recovery control. Video is a supplied Meet/Zoom link; there is no video service, payment flow or guaranteed immediate response. Caregiver invitations use account codes, not delivered invitation emails; the founder accepted this for launch on 14 September 2026 (D035).
- PDFs embed Latin/Devanagari fonts. Unsupported scripts/emoji produce an explicit error; complete HTML remains available. PDFs show six complete medications and six recent document titles, with prominent remaining counts. Downloaded copies cannot be recalled after revocation. See OQ006.
- Post-import timezone changes re-bucket derived history through the durable summary queue while preserving raw timestamps (D032). The browser must remain open, awake and online for a large import. Safe re-import requires the same source name. No offline health-data cache or physical-phone verification is claimed.
- Documents are limited to PDF/JPEG/PNG originals up to 3 MiB. Export is a direct streamed download, not an emailed link or backup/restore format. Export/deletion requests have bounded server deadlines; interruptions fail explicitly and deletion retains a retry fence. Neither operation promises immediate provider-backup erasure. Other patients' retained clinical free text is not automatically scrubbed of names.
- Pharmacy providers prepare external search links only. Apollo requires re-entering the query. No prescriptions, inventory, pricing or partner API is inferred; no purchase links appear in insights.
- The legal pages are preview notices, not a compliance certification. Verifiable parental authority, child-monitoring restrictions/exemptions, retention, correction/nomination/grievance processes, actual operator/contact details and cross-border clinical eligibility require counsel before launch (OQ001/OQ007). A guardian consent checkbox is not parental verification.
- Native controls/shared CSS replace adding another UI runtime. Chrome's current installability checks replace the deprecated Lighthouse PWA category, as documented in D010. Device prices/specifications are a dated 8 September 2026 snapshot, not live quotes.

## Exact next steps

1. **Use the existing infrastructure.** Keep Supabase in Mumbai. For a fresh environment, use Node 24/npm 11.19.0, `npm ci`, `npm run db:migrate`, `npm run storage:setup` and the documented seed commands. Preserve existing `.env.local`; never commit it. Keep `SUPABASE_SECRET_KEY`, `DATABASE_URL` and `CONSENT_IP_SALT` server-only. Public clients use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
2. **Keep hosted CI green.** GitHub Actions now passes both quality and from-scratch database replay. Require both jobs before release (OQ002).
3. **Keep Vercel environments separated.** Production is deployed at `https://hms-indol-psi.vercel.app`. Add deliberate Preview Supabase public values and a Preview `NEXT_PUBLIC_APP_URL` before using Preview as staging (OQ011).
4. **Finish Auth delivery setup.** Allow the deployed origin and Auth callback/confirmation URLs in Supabase. Configure the email template/SMTP as appropriate and verify a real magic link with an authorised recipient. Existing tests generate synthetic links without emailing anyone.
5. **Activate minute scheduling.** Set the same random `CRON_SECRET` (at least 32 characters) in the server environment and restricted Supabase Vault, set the deployed HTTPS origin, then run `npm run cron:setup`. Inspect both `cron.job_run_details` and the HTTP responses in `net._http_response`. Use the Vercel fallback only if the chosen plan supports one-minute cadence; do not run both schedulers.
6. **Verify the configured notification services.** Vercel lists Resend and VAPID variables, and the application implements persistent Web Push subscriptions, recipient rechecks and transport. Confirm the sender/domain, test authorised email and physical-device push delivery, and monitor failed/exhausted rows. Sample data remains stubbed.
7. **Complete legal and clinical launch review.** Have counsel approve verifiable parental consent and applicable child-monitoring rules, operator/grievance contacts, medical/security-record retention and deletion, international patient eligibility and telemedicine terms. Verify real clinicians against their registration councils before administrator approval. Keep preview/legal/sample notices until these dependencies are resolved.
8. **Review product limits before advertising them.** Refresh dated catalogue sources and decide whether paid/video consultations or future device integrations are required. Timezone re-bucketing and browser Realtime invalidations are shipped and verified; they do not make the upstream wearable feed continuous.

Do not treat this handoff or passing local tests as permission to launch a public clinical service. Deployment, provider configuration and the legal/clinical launch dependencies above remain founder-owned steps.
