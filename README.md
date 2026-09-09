# HMS

A personal health history and doctor-sharing application. The existing Next.js App Router scaffold is being completed in the milestone order in PLAN.md.

## Five-line run guide

1. Use Node.js 24 (`nvm use`) and npm 11.19.0 (`npm install --global npm@11.19.0`).
2. Install locked dependencies with `npm ci`.
3. Keep your existing `.env.local`; for a new checkout copy `.env.example` and fill in the Supabase credentials.
4. Run the quality gate with `npm run lint && npm run typecheck && npm test`.
5. Start with `npm run dev` and open [localhost:3000](http://localhost:3000).

## Verification

`npm run build` verifies production compilation. For browser tests, run `npx playwright install chromium`, then `npm run build && npm run e2e`. Playwright starts the production server on port 3100. Unit tests do not read developer credentials.

The GitHub workflow runs lint, typecheck, tests, build, and browser checks on pushes and pull requests. A Git remote must be configured and pushed before a hosted Actions result can be observed.

## Configuration and progress

Use only the publishable key in public clients. `SUPABASE_SECRET_KEY`, `DATABASE_URL`, cron credentials, and consent salts remain server-only. Supabase stays in Mumbai. The environment template documents required and optional services; never commit `.env.local`.

Read PLAN.md and AGENTS.md before development. PROGRESS.md records verified milestones; DECISIONS.md records architecture choices and OPEN_QUESTIONS.md tracks unresolved dependencies. M0 provides tooling; later feature milestones are not complete until their recorded verification passes.

## Patient screens

New sign-ins open four-step onboarding; completed accounts open `/today`. The three tabs are Today, Doctors and History. More contains imports, family management, cycle display opt-in, raw records, baselines, alert configuration and account access. Choose your timezone before importing; post-import timezone changes are not enabled in this version. In History, All opens bounded pages with Earlier/Latest controls instead of dropping old readings. Select a chart point or a reading day to inspect its source.

Today can process bounded, owner-only summary work while the page is open. This helps local imports complete even before a deployed cron exists; persisted jobs and escalation still use the independent minute dispatcher in production. Missing data is never shown as zero. No health data is cached for offline use.

`npm run build && npm run golden:verify` runs the currently enabled golden paths against the production build at 390 px. It requires Poppler's `pdftotext` on PATH (or `HMS_PDFTOTEXT` pointing to that executable) for the actual guardian-PDF check. Use `HMS_TEST_PORT` to choose another port. Tests create only synthetic accounts/readings and remove them afterwards. Do not overlap database migration/RLS tests with live Auth tests: temporary Auth-trigger DDL can block Auth writes until the test transaction rolls back. Stop an active development server before final production verification to avoid stale development artifacts.

## Care team and summaries

Patients link verified doctors from Doctors, choosing summary-only or full History and optional alerts. `/doctor` offers registration, a scoped patient list and a consult queue. Only a database-admin role can verify credentials through `hms_doctor_profile`; patients cannot self-verify. `npm run seed:doctors` seeds one verified and one pending fictional practitioner, visibly labelled Sample data. No real doctor availability or licence verification is implied.

Consults attach immutable summaries. The doctor accepts, can schedule a future time and paste an HTTPS Google Meet/Zoom link, exchanges messages, then closes with a note that appears in History. Use Refresh messages to fetch new messages; chat does not use realtime subscriptions. No video service or payment is provisioned.

More → Family holds caregiver account-code invitations, acceptance, scope changes and immediate revocation. Ordinary caregiver access is read-only and audited; alerts require the recipient's notification consent. A guardian creates and manages a dependent without an Auth account. At 18, a guardian can offer the stable profile to the dependent's confirmed account with matching DOB. Acceptance requires an empty signup profile and explicit replacement/ownership/consent confirmations. Existing history is never merged or replaced. Prior guardian consent stays recorded; previous sharing/contact authority ends. Legal parental verification remains a pre-launch dependency.

Clinical summaries support 30/90-day aggregates, immutable saved snapshots and private one-page PDF downloads. Every shared read checks current access and writes an audit row. Downloaded files cannot be remotely revoked. PDFs include up to six complete medication entries and six recent document titles, with counts directing readers to remaining entries in the app. Embedded fonts support Latin and Devanagari; unsupported characters produce a clear error instead of silently missing text. See OQ006.

`npm run pdf:verify` renders the three seeded personas plus guardian, long-entry and multilingual stress fixtures under `test-results/clinical-pdf/`. It requires Poppler's `pdfinfo`, `pdftotext` and `pdftoppm` on PATH, or `HMS_PDFINFO`, `HMS_PDFTOTEXT` and `HMS_PDFTOPPM` overrides. Inspect the resulting PNGs after layout changes. The production route uses the same renderer and bundled fonts; it needs no Poppler or external font service.

PWA verification uses current Chrome installability errors, the actual manifest/192- and 512-px PNG icons, and the active worker. Lighthouse's PWA category is deprecated; see D010. Chrome's install menu or Safari's Share → Add to Home Screen installs the app. It still needs a connection.

## Analytics jobs

`npm run summaries:recompute` drains durable pending summary work using bounded, retryable batches, including alert evaluation. `npm run summaries:verify` compares the three seeded profiles' stored summaries, scores, baselines and insights against fresh pure calculations.

Sample data covers the last 90 complete days in the selected profile's timezone. The version-2 seed correction regenerates only explicitly marked synthetic profiles with no uploads, documents, consults or manual cycle logs; it refuses to reset profiles containing such data. Missing readings remain missing. Scores require seven prior days of usable inputs. See D007 for formulas, source selection and cycle limitations.

## Alerts and minute-by-minute scheduling

`/more/alerts` manages owner/guardian thresholds, acknowledgement, email consent, contact details/consent and the local browser notification test. Server push, SMS and WhatsApp are explicit stubs. No real email is sent without configured Resend credentials/sender; sample notifications always use a privacy-preserving console stub. Never rely on these notices for emergencies.

After deployment, set a random `CRON_SECRET` of at least 32 characters in the server environment, set `NEXT_PUBLIC_APP_URL` to the deployed HTTPS origin, and run `npm run cron:setup` with the same private values. It schedules Supabase `pg_cron`/`pg_net` every minute using restricted Vault secrets. It refuses localhost and exposed Vault permissions. Check `cron.job_run_details` and the matching HTTP status in `net._http_response`; SQL scheduling success alone does not prove HTTP success. The protected endpoint supports both POST and GET. Do not run both schedulers. `docs/cron-vercel.example.json` is a fallback only if the existing Vercel plan supports one-minute cadence; never silently reduce cadence or buy a plan.

`npm run build && npm run alerts:verify` uses a separate, ephemeral local cron secret, disables real email, verifies synthetic live alerts/acknowledgement and the Chrome worker at 390 px, and removes its synthetic account/data. Unit/database tests use controlled clocks for the 15-minute deadline, acknowledgement/consent races, expired leases, caregiver revocation and overlapping dispatches. Inspect pending/failed `alert_deliveries` and `summary_jobs` operationally; retries are bounded. Missing deployment/notification configuration is tracked in OQ004.

## Database and authentication checks

`npm run db:generate` generates Drizzle migrations; `npm run db:migrate` applies them using the private `DATABASE_URL`. `npm run db:verify` requires a real Postgres connection and verifies migration-from-scratch/RLS in a temporary schema inside a rolled-back transaction. `npm run db:advisors` runs Supabase's advisors. `npm run db:reset` refuses hosted databases: it requires an explicit local `hms_test` database and `HMS_ALLOW_DB_RESET=1`.

`npm run build && npm run auth:verify` exercises real Supabase magic-link token redemption in Chromium, guardian consent, and sign-out. It creates and removes a synthetic test account, and sends no email. The regular browser suite (`npm run e2e`) checks anonymous access and minor signup rejection without sending email. For production sign-in, allow the final app URL and `/auth/callback` in Supabase Auth redirect configuration. A token-hash email template may use `/auth/confirm?token_hash={{ .TokenHash }}&type=email`; both callback forms are implemented.

## Import and sample data

After migrations, `npm run seed` creates all three labelled 90-day sample personas. Repeat runs deduplicate existing readings. These reserved-domain accounts are fixtures, not delivered logins; signed-in users can load the same sample personas from `/more/data` into their own or guardian-owned profile after giving consent.

The same command seeds the fictional doctor directory and 20 dated device catalogue entries. `npm run seed:devices` updates only those named entries and verifies their public RLS read; it preserves unrelated catalogue rows. `/more/devices` compares source-verified features with currency/budget, battery and screen filters. Unknown prices remain “Check price”; no currency conversion or automatic device integration is implied. Update the row's sources and verification date whenever changing a price/specification. The live catalogue UI test is in `npm run golden:verify`, not the credential-free CI suite.

`/more/data` accepts Apple Health `export.zip`, generic CSV and recursively selected CSV folders. ZIP/XML and CSV source files stay in a browser Web Worker; only batches of at most 1,000 canonical metrics and 1 MiB reach the server. Keep the tab open. Cancel or retry safely by selecting the same file/folder and source name. Invalid/unsupported records are counted. Apple HRV SDNN is not imported as RMSSD. The CSV template lists timestamp, metric type, value and canonical unit; timestamps must include a UTC offset.

`npm run build && npm run ingestion:verify` checks real CSV persistence and two imports of a generated 210 MiB XML ZIP, including API bounds, deduplication and a 512 MiB renderer-memory ceiling. It needs the supplied Supabase keys/database and Chromium on macOS or Linux (`ps` supplies RSS). Its temporary test account/data are cleaned up. Fixture ZIP and a JSON memory/count report are written under ignored `test-results/`. The sample personas created by `npm run seed` are intentionally retained.

The live benchmark permits fifteen minutes per import, fails after two minutes without persisted progress, and prints progress once per minute (D019). Keep the test machine awake and connected. On macOS, `caffeinate -i npm run ingestion:verify` prevents idle sleep only while the command runs; keep the lid open. A sleep-interrupted test is not a valid memory or deduplication result.

Folder imports accept up to 20,000 CSV files and stream them sequentially. They auto-detect the HMS four-column format, legacy Google Fit `Daily activity metrics`, and Google Health/Fitbit Takeout canonical physical-activity files. Supported Takeout readings are heart rate, resting heart rate, steps, active/total calories, RMSSD HRV, SpO₂, respiratory rate, skin temperature and weight. When a legacy directory contains Google's consolidated `Daily activity metrics.csv`, redundant date-named siblings are skipped. Google Health account/settings files, empty datasets and duplicated summary formats are not reinterpreted as readings; diagnostics name the first 20 skipped files and the UI reports recognised versus skipped file counts. Date-only legacy rows use the profile's history timezone; Google Health timestamps carry UTC. Re-select the same folder with the same source name for an idempotent retry.

## Documents, data rights and preview legal pages

After migrations, run `npm run storage:setup` once. It creates the private `hms-documents` bucket only if absent and requires the restrictive Storage policy. Existing unexpected bucket settings are reported, not silently changed. History accepts PDF/JPEG/PNG originals up to 3 MiB through owner/guardian routes with ingestion consent. Reads require current owner/full-history permission and are audited. There are no public or durable signed document links.

Your account → Export all owned profiles streams a direct ZIP of CSVs, records and original documents, including owned dependents but never merely linked patients. It preserves sample provenance; this is a record copy, not a backup/restore import format. Account deletion requires typing DELETE plus separate confirmation for dependents. A durable fence freezes new work; files, health rows and identifiers are removed before the Auth account. Success means the operation completed in that request. On an interrupted request, return to `/account/delete` and retry. Provider backups and other patients' retained clinical text are not promised erased; see D014 and OQ007.

Privacy, terms and the health disclaimer are public preview pages. Operator/contact, parental verification, retention and cross-border care requirements need legal review before launch. `/more/pharmacy` prepares manually requested external search links only; Apollo requires re-entering the query. No pharmacy API, orders, prescriptions or insight purchase links exist.

## Deployment status

M7 uses PLAN's production-build fallback because Vercel CLI `whoami` reports logged out (D017). No public URL, temporary deployment or third-party account was created. Before deployment, configure Vercel's existing project with the documented server-only/public environment variables and an appropriate supported Node runtime. Then allow its HTTPS Auth callbacks in Supabase, run the browser smoke tests on that URL and activate the minute scheduler with the matching secret. Legal and real notification prerequisites in OPEN_QUESTIONS.md still apply.
