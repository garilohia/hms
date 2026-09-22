# HMS build handoff — updated 19 September 2026

## Status: M0–M8 implemented; external launch gates remain

All nine original milestones are implemented. Subsequent work adds versioned native ingestion, bearer-token authentication, immutable retry receipts, measured latency/freshness, timezone re-bucketing, private Realtime recovery, fair resumable provider paging and shared provider request budgets. It does not claim signed native binaries, vendor approval, guaranteed wearable latency, a supervised pilot or clinical/legal approval.

The current deployed application is `16652ad489d0e29e608090ba6259de2d5b23c87c`, verified in Mumbai (`bom1`) at deployment `dpl_8J3Nq59EKmCnLEQLC76c2uVaqaco`. Release-documentation commit `71dc2ad` records its deployment evidence; the later local chart/audit follow-through is not deployed. Both hosted quality/database jobs and all nine hosted public checks pass. Full signed-in hosted acceptance is **not green** (OQ016) and was not rerun on this release. See [the current release report](docs/verification/provider-budget-2026-09-19.md) and [fresh local completion checks](docs/verification/completion-matrix-2026-09-19.md).

The original large streaming-import and shorter verification matrix evidence remains below. The linked Vercel project and production site now exist at `https://hms-indol-psi.vercel.app`. The isolated Mumbai Preview database and separate public Supabase settings also exist, but Preview still lacks its server/database credentials, Storage, synthetic fixtures, Auth/origin setup and deployed acceptance. Staging must not silently use production health data.

The 18 September Realtime follow-up passed `npm run check` (136 unit tests), `npm run build` (55 routes) and all five patient/doctor/Realtime golden tests. Live History updates preserve the selected page and reading, and chat recovers messages sent during browser network interruption. These checks used a local production build against the real Supabase project with synthetic fixtures; they do not establish the currently deployed commit. See PROGRESS.md for the earlier full verification matrix and this follow-up's exact commands.

The earlier 19 September provider/notification follow-up adds resumable late-reading sync, explicit provider revocation and read-only configuration verification. Its historical evidence remains in `docs/verification/readiness-2026-09-19.md`; subsequent recovery and shared-budget evidence is separated below. See `docs/PROVIDER_SETUP.md` for credential placement and `docs/NOTIFICATION_ACCEPTANCE.md` for controlled delivery testing. Do not replace the already configured production encryption key.

Earlier runtime `ea36c7c` prevented clinical-summary clicks before hydration and passed hosted quality/database CI. Its full signed-in check had seven passes and four intermittent failures; all four passed in one focused rerun with unchanged deadlines. The later `0d9bcf6` full hosted run had five passes, one caregiver navigation timeout, one interrupted guardian case and four not run. Neither result establishes a clean full acceptance pass for the current release. OQ016 remains open, alongside the sender/physical-device, Preview-access, provider and security/legal launch gates. Exact failure and synthetic-cleanup evidence is preserved in [the recovery report](docs/verification/recovery-2026-09-19.md).

## What works

1. The existing Next.js 16.3.4 App Router scaffold, strict TypeScript, Tailwind, npm lockfile and Supabase SSR helpers are retained. The nonexistent-todos demo is removed. Public/secret Supabase key names match the supplied project.
2. Adult magic-link authentication, database-enforced minor signup rejection, guardian-owned dependent profiles, consent provenance and audited non-self reads are implemented. The current inventory has RLS on all 24 public tables. Private `integration_connections` and `provider_request_budgets` have forced RLS; private `native_ingestion_batches` and `push_subscriptions` have no `anon`/`authenticated` SELECT privilege, rather than RLS. The original M8 test matrix below covered 23 tables at that time.
3. Three deterministic, labelled 90-day sample personas, generic CSV and streaming Apple Health ZIP imports use the common normalisation layer. The browser Web Worker sends bounded batches; no server function receives the archive.
4. Pure, tested analytics produce local-day summaries, 28-day median/MAD baselines, explainable readiness, cycle estimates and non-diagnostic insights. Durable database jobs support recomputation and retry protection.
5. All default alert rules, exact unusual-reading copy, acknowledgement, consented escalation deadlines, outbox retries and protected minute-dispatch routes are implemented. Local Chrome notification and console-stub delivery are verified.
6. Three patient tabs—Today, Doctors and History—work at 390 px. More holds configuration, imports, raw history, cycle opt-in, data rights, devices and legal pages. Chrome PWA installability is verified; health data is not cached offline.
7. Doctor registration/verification boundaries, scoped sharing, consultation requests, scheduling, messages, closing notes and immutable 30/90-day clinical summaries/PDFs work. Caregiver invitation, acceptance, read-only access and revocation are audited.
8. Guardian consent is displayed on summaries/PDFs. Explicit conversion at 18 preserves the health-profile ID and history, requires the receiving adult's consent, and retires mandatory guardian authority. Existing recipient history is not merged or overwritten.
9. Private original documents, streamed account ZIP export and retryable hard deletion work end to end. Export covers owned profiles, not merely linked patients. Deleting a doctor preserves other patients' consultation history with anonymised references.
10. A 25-device, manufacturer-sourced catalogue has dated prices/specifications and honest unknowns. It held 20 rows at M7/M8 and was extended to 25 during the post-M8 wearable-coverage pass (D016); PROGRESS.md's M7 entry records the earlier count as history. Public legal previews and manually requested pharmacy search links are implemented without partner accounts, orders or implied integrations.
11. Patient reads coalesce concurrent updates, retry transient failures within bounds, recover after reconnect and discard stale responses. History retains the selected reading/page; old history is not presented as a fresh Today summary. Local failure-injection and Realtime tests verify these behaviours, not a hosted latency guarantee.
12. Google Health and WHOOP sync rotate collection cursors without skipping unfinished pages; Google head probes do not advance historical completion. All provider HTTP requests, including OAuth, refresh and revocation, require a committed shared allowance. Missing configuration/database access fails closed. This protects the configured client/project budget; it does not establish real-device compatibility or one-minute capacity.
13. The expanded design harness requires every route/state, doctor/caregiver views and Advanced overlays at 390px in both colour schemes. Compact charts retain unit/date axes; overlay lines share the baseline boundary language and accessible end labels. The latest local manifest contains 87 screenshots with no page errors, overflow, notes or cleanup failures.
14. Synthetic live-test teardown is fail-safe across owned resources: Auth deletion, audit cleanup, browser/CDP closure and database closure are all attempted and labelled even when an earlier step fails. Injected-failure unit coverage and the Auth, alert, import and full golden suites pass on this path (D047).

## M8 corrections

- Lost-response fault injection reproduced two consultations from one intended request. The UI now reuses an in-memory ID for unchanged retries, using the database's existing idempotency checks. Messages clear on confirmed save even if the following refresh fails. Browser regressions assert one consultation and exactly two messages after injected failures.
- Doctor-page and care-API pagination cursors now require complete UUID/timestamp shapes. Malformed URL values return a controlled not-found page; malformed API cursors return 400. Microsecond timestamp strings are preserved.
- The environment template no longer suggests that VAPID keys alone enable the unimplemented server-push transport.
- The live import test has progress reporting, a two-minute no-progress watchdog, fifteen minutes per import and a 35-minute overall envelope (D019). The previous undocumented 400-second allowance and an initial ten-minute replacement both expired during healthy, progressing re-imports. The ≥200 MiB file, ≤512 MiB memory, batch, worker, row-count and deduplication assertions are unchanged; production deadlines are unchanged.

The requested whole-repository `codex review` completed and reported no actionable findings. Independent regression work found the issues above; that review result is not a correctness guarantee. Details are in `docs/verification/m8-review.md`.

## Verification evidence

### Current release — 19 September 2026

These results are recorded for the shared-budget release in [the provider-budget report](docs/verification/provider-budget-2026-09-19.md) and PROGRESS.md. Documentation edits do not change the deployed runtime.

| Check | Verified result |
|---|---|
| `npm run check` | Lint, strict TypeScript, both-mode contrast and all 366 unit tests pass. |
| `npm run build` | Production build passes; 55 routes. |
| `npm run db:verify` | All 115 tests pass in 181.59 seconds, including full migration replay, consent/access boundaries and shared-budget concurrency. |
| Migration inventory | Production and Preview each have 43 migrations, through `0042`. Private budget counters have forced RLS and no browser/service-role read privilege. Preview contains zero profiles/metrics; no production health data was copied. |
| Full local `npm run golden:verify` | All eleven tests pass together in 5.7 minutes, covering the seven golden paths and added regressions. Notifications are stubbed. This run preceded the final URL-mutation guard; that guard then passed the final unit gate/rebuild and a one-test wearable-hub check (13.8 seconds). |
| Local `npm run e2e` | All nine public/boundary tests pass in 18.5 seconds. |
| Hosted GitHub Actions | Both quality and database jobs pass for `16652ad` in [run 35440701188](https://github.com/garilohia/hms/actions/runs/35440701188). |
| Hosted public Playwright suite | All nine tests pass on promoted runtime `16652ad` in 25.4 seconds. |
| Minute dispatcher | Actual scheduled HTTP response at 11:42 UTC on 19 September is 200 with `timed_out=false`. This proves dispatch, not provider ingestion or notification receipt. |
| Hosted signed-in acceptance | Not green; not rerun on `16652ad`. The prior caregiver `/more/alerts` navigation timeout remains OQ016. No deadline or substantive assertion was relaxed. |

Additional local handoff checks on the current application have passed: `npm run auth:verify` (two tests, 9.5 seconds), `npm run alerts:verify` (one test, 17.6 seconds, outbound settings blank and no pending deliveries/connections at preflight), `npm run pdf:verify` (six one-page fixtures, all six renders visually inspected), and `npm audit --omit=dev` (zero reported production vulnerabilities). These do not prove inbox or physical-device delivery.

The 22 September cleanup follow-through passes `npm run check` with 368 unit tests, standalone Auth (two), alerts (one), all eleven golden tests together and both importer tests with outbound transports/providers blanked. The 210 MiB Apple fixture peaks at 249,511,936 renderer bytes and inserts zero on re-import. This closes the known teardown-order weakness; shared Production dispatch remains unsuitable for regular acceptance until Preview is operational.

Fresh `npm run ingestion:verify` passes both tests in 2.3 minutes: Apple import inserts 6,000 rows in 61,629 ms and re-import inserts zero in 62,663 ms; the folder-import case passes in 6.1 seconds. Peak renderer RSS is 324,255,744 bytes (below 512 MiB); 1,243 batches remain within 1,000 records and 260,111 bytes each. The [completion matrix](docs/verification/completion-matrix-2026-09-19.md) records the exact fixture and measurements, not a general speed guarantee. Fresh local design-audit validation also passes with 87 screenshots, including required doctor/caregiver and Advanced-overlay states; it does not establish hosted signed-in reliability or physical-device behaviour.

Current security-advisor results are not clean: Production retains the managed `pg_net` extension and leaked-password-protection warnings tracked in OQ017, plus seven informational notices. Preview has seven informational deny-by-default/no-policy notices and no warnings/errors. The older clean advisor results below do not override these findings.

### Historical original M8 verification

These are actual passing commands on the original M8 worktree, not the current release's counts. The large-import command passed twice in one run, and every command in the shorter matrix passed in each of two complete sequential runs. Local tooling then was Node 26.8.1, npm 11.19.0 and Playwright 1.63.0; Node 24 is the configured CI/deployment target. Hosted CI and physical-device testing were not established by that matrix; current hosted CI evidence is recorded above.

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

- Google Health and WHOOP OAuth connections, encrypted token storage and bounded sync are implemented; production provider approval, credentials and live-account acceptance remain OQ012. Garmin, Oura, Withings and other partner connectors remain gated. The versioned HealthKit/Health Connect server contract and acceptance documents exist, but compiled companions, encrypted device queues, APNs/FCM credentials and physical-device verification remain pending. Catalogue features do not imply HMS import compatibility; Apple HRV SDNN is not relabelled RMSSD.
- Shared allowance and fair paging are implemented, but approved provider quotas, measured multi-user capacity, late-arrival coverage and source-to-recipient delay still require authorised acceptance. A failed WHOOP connection can leave permission at the provider after token exchange but before identity lookup; the failure notice directs manual provider-side removal and does not claim automatic cleanup. See D043/OQ012.
- A public Vercel production site and green hosted GitHub Actions runs now exist. The minute scheduler is active with actual HTTP 200 evidence. Following an environment-scoping incident, the founder restored Resend settings and authorised a replacement VAPID pair. Real inbox/device delivery remains unverified; old browser subscriptions need re-enabling (OQ004 and `docs/verification/deployment-2026-09-18.md`). No third-party partnership or order was created.
- Hosted signed-in reliability remains OQ016 despite passing local golden paths and hosted public tests. Production security hardening remains OQ017; neither gate is resolved by a successful build or migration replay.
- Doctors in the seed are fictional Sample data. Real credential checks and clinician onboarding must precede clinical use. Chat updates through private Realtime Broadcast and retains explicit Refresh as a recovery control. Video is a supplied Meet/Zoom link; there is no video service, payment flow or guaranteed immediate response. Caregiver invitations use account codes, not delivered invitation emails; the founder accepted this for launch on 14 September 2026 (D035).
- PDFs embed Latin/Devanagari fonts. Unsupported scripts/emoji produce an explicit error; complete HTML remains available. PDFs show six complete medications and six recent document titles, with prominent remaining counts. Downloaded copies cannot be recalled after revocation. See OQ006.
- Post-import timezone changes re-bucket derived history through the durable summary queue while preserving raw timestamps (D032). The browser must remain open, awake and online for a large import. Safe re-import requires the same source name. No offline health-data cache or physical-phone verification is claimed.
- Documents are limited to PDF/JPEG/PNG originals up to 3 MiB. Export is a direct streamed download, not an emailed link or backup/restore format. Export/deletion requests have bounded server deadlines; interruptions fail explicitly and deletion retains a retry fence. Neither operation promises immediate provider-backup erasure. Other patients' retained clinical free text is not automatically scrubbed of names.
- Pharmacy providers prepare external search links only. Apollo requires re-entering the query. No prescriptions, inventory, pricing or partner API is inferred; no purchase links appear in insights.
- The legal pages are preview notices, not a compliance certification. Verifiable parental authority, child-monitoring restrictions/exemptions, retention, correction/nomination/grievance processes, actual operator/contact details and cross-border clinical eligibility require counsel before launch (OQ001/OQ007). A guardian consent checkbox is not parental verification.
- Native controls/shared CSS replace adding another UI runtime. Chrome's current installability checks replace the deprecated Lighthouse PWA category, as documented in D010. Device prices/specifications are a dated 8 September 2026 snapshot, not live quotes.

## Exact next steps

1. **Use the existing infrastructure.** Keep Supabase in Mumbai. For a fresh environment, use Node 24/npm 11.19.0, `npm ci`, `npm run db:migrate`, `npm run storage:setup` and the documented seed commands. Preserve existing `.env.local`; never commit it. Keep `SUPABASE_SECRET_KEY`, `DATABASE_URL` and `CONSENT_IP_SALT` server-only. Public clients use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
2. **Keep CI and acceptance separate.** GitHub Actions passes both quality and from-scratch database replay. Require both jobs before release (OQ002). Diagnose the recorded hosted caregiver navigation failure, retain unchanged assertions/deadlines and obtain a clean full signed-in run before closing OQ016; no such current-release pass is claimed.
3. **Finish isolated Preview.** Production is deployed at `https://hms-indol-psi.vercel.app`. The free Mumbai `hms-preview` database and separate Preview public settings now exist. Supply its server/database credentials, set up private Storage and synthetic fixtures, configure Auth/origin, then deploy and test (OQ011). No production health data was copied.
4. **Finish Auth delivery setup.** Allow the deployed origin and Auth callback/confirmation URLs in Supabase. Configure the email template/SMTP as appropriate and verify a real magic link with an authorised recipient. Existing tests generate synthetic links without emailing anyone.
5. **Keep minute scheduling healthy.** Supabase minute dispatch is active with a matching restricted Vault/server secret and actual HTTP 200 evidence. Inspect both SQL runs and HTTP results after deployments; a successful cron SQL statement can still return HTTP 401. Do not add a duplicate Vercel schedule.
6. **Verify notifications.** Resend settings and replacement VAPID keys are configured. On previously subscribed devices, Disable then Enable instant alerts. Confirm the sender/domain, test authorised email and physical-device push delivery, and monitor failed/exhausted rows. Sample data remains stubbed.
7. **Complete legal and clinical launch review.** Have counsel approve verifiable parental consent and applicable child-monitoring rules, operator/grievance contacts, medical/security-record retention and deletion, international patient eligibility and telemedicine terms. Verify real clinicians against their registration councils before administrator approval. Keep preview/legal/sample notices until these dependencies are resolved.
8. **Complete provider setup and capacity acceptance.** Follow `docs/PROVIDER_SETUP.md`, including the canonical `GOOGLE_HEALTH_QUOTA_PROJECT_ID`, real OAuth credentials/approvals and the existing Production encryption key. Deployments sharing a provider client/project must also share the quota database; separate databases do not coordinate allowance. Verify actual accounts/devices, fair scheduling and source-to-recipient delay before advertising update intervals. Refresh dated catalogue sources; browser Realtime and head probes do not make upstream wearable feeds continuous.
9. **Close the remaining verification/security gaps.** The fresh large-import and full design-audit outcomes are recorded separately from historical results. Follow OQ017's supported Supabase review for extension privileges and leaked-password protection; do not blindly relocate a managed extension or treat informational notices as proof of security.

Do not treat this handoff or passing local tests as permission to launch a public clinical service. Deployment, provider configuration and the legal/clinical launch dependencies above remain founder-owned steps.
