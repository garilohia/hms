# Architecture decisions

These decisions incorporate the founder's answers on 8 September 2026. They are requirements for the forthcoming milestones, not a claim that those milestones are implemented.

## D001 — Adopt the existing scaffold

Keep Next.js 16.3.4, App Router, strict TypeScript, Tailwind, npm with `package-lock.json`, and the existing `utils/supabase/` helpers. Use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for public clients and keep `SUPABASE_SECRET_KEY` server-only. Complete the remaining M0 tooling and run `npx skills add supabase/agent-skills` at the end of M0.

Reason: the founder explicitly asked to adopt the working scaffold; recreating it or downgrading to the original plan's Next.js 15 would discard existing work.

M0 tooling: use Node.js 24 for CI and the documented runtime, npm 11.19.0, and Node 24 type definitions. The installed Vitest 5 requires Node 22.12+ and compatible types; the host's Node 26 also passed the checks. Source: https://vitest.dev/guide/.

## D002 — Browser-based Apple Health import

Run application compute entirely within Vercel, Supabase, and the user's browser. Do not provision a separate worker service.

The user selects `export.zip` locally. A browser Web Worker streams ZIP decompression and SAX-style parsing of `export.xml`, maps records through the adapter's `normalise()`, and POSTs bounded normalised batches to the ingestion API. Do not load the whole archive or XML into memory, or upload the archive to a server function. Use backpressure so parsing cannot accumulate an unbounded queue of pending batches. Permit at most three 1,000-reading persistence calls in flight so authentication/network latency overlaps without changing the 1 MiB request boundary or allowing unbounded memory growth.

The API independently validates every batch and checks the authenticated actor's ownership/guardianship and ingestion consent for the target profile. Persist deduplicated metrics and pending summary work in Supabase. Show progress, cancellation, and recoverable failures in the UI. Processing depends on the browser remaining open; safe re-import uses the existing deduplication key.

Reason: large Apple Health archives must be importable without holding a 500 MB file in a server function or introducing another hosting service.

## D003 — Durable jobs dispatched every minute

Use Supabase `pg_cron`, with `pg_net` for the HTTP invocation, to call an authenticated Next.js route handler every minute. Vercel Cron is the fallback only if the existing deployment supports the same cadence; do not purchase a plan or silently reduce the cadence.

Keep pending summary recomputations and escalation deadlines in Postgres. Ingestion marks affected profile/day pairs for recomputation. Each invocation claims bounded work, recomputes summaries/baselines, and processes urgent alerts whose 15-minute acknowledgement deadline has passed. Recheck acknowledgement, consent, and current access before escalation. Use durable retry state and idempotency controls so overlapping calls cannot lose work or repeatedly notify recipients. Neither job depends on an open browser or an in-process timer. Store scheduler credentials server-side.

Reason: scheduled recomputation and escalation must survive browser closure and function restarts while staying within Vercel and Supabase.

## D004 — Guardian-owned dependent profiles

Under-18 users cannot self-sign up or receive an independent login account. Enforce this on the server/auth account-creation path as well as in the UI. An adult guardian creates a dependent profile under the guardian's existing account, gives consent on the dependent's behalf, and owns/manages that dependent's data.

Separate the stable health-profile ID from the optional authentication-account ID. Patient-related `user_id` foreign keys refer to the health profile; authorization resolves the authenticated actor separately. A dependent has no authentication account. Record its owning account explicitly so RLS and all ingestion, sharing, export, and deletion operations can enforce ownership without merging the guardian's and dependent's health histories.

Add `role: caregiver | guardian` to `caregiver_links`. A guardian link is full-scope (`summary_only`, `full_history`, `alerts`) and grants management rights, including ingestion and consent, through explicit server/RLS rules. It is not limited to the ordinary caregiver's read-only access. The dependent cannot revoke it. Ordinary caregiver links remain scoped, read-only, and revocable. Record guardian reads/actions in `audit_log`.

Consent records identify the subject profile, granting adult, and authority (`self` or `guardian`), alongside policy version and timestamps. Doctor-facing summaries and clinical PDFs show "Consent given by guardian" when the relevant consent was granted on the dependent's behalf.

At age 18 or later, the guardian may initiate conversion to a normal account. Verify age and the destination account's control, transfer ownership/authentication linkage atomically, and retain the same profile ID, history, consent provenance, and audit trail. Retire the mandatory guardian link; subsequent caregiver access uses the ordinary revocable sharing rules. Conversion is not automatic on the birthday.

Reason: minors are supported through guardianship at launch, with a continuous health history when they become adults. The verifiable-parental-consent method requires legal review before launch; see OPEN_QUESTIONS.md.

## D005 — Database authorization and reproducible verification

Use Drizzle's generated schema migration and custom SQL migration for Auth triggers, RLS, grants, and audited operations, as required by PLAN.md. This takes precedence over the installed Supabase skill's generic CLI migration workflow.

Patient-related IDs identify health profiles. Auth IDs identify actors. Direct Data API reads are limited to a patient's own profile/history. Doctor, caregiver, and guardian reads go through invoker wrappers calling checked functions in the unexposed `hms_private` schema; those functions enforce live identity, current consent and sharing scope and insert an audit row in the same transaction. Definer privileges are confined to those checked operations and Auth/constraint triggers. Account roles are stored in profiles, not taken from user-editable JWT metadata.

Reproducibility tests apply the complete migrations to uniquely named temporary schemas on real Postgres, with the same grants, policies, and functions, and roll back schemas and synthetic Auth fixtures after each suite. CI uses PostgreSQL 17 with a minimal Auth SQL fixture for RLS tests; the separate live Auth browser test uses the supplied Supabase service and cleans up its synthetic account. `db:reset` is restricted to an explicitly authorised local database named `hms_test`.

The live magic-link test generates a one-use token through the Supabase admin API without sending email, then exercises the actual browser confirmation, cookies, dependent creation, and sign-out. It verifies Auth/session behaviour but not inbox delivery or SMTP configuration.

## D006 — Bounded, repeatable ingestion

Use zip.js with a file-backed `BlobReader` and a streaming writable, plus the SAX-style `saxes` parser, inside the browser's dedicated Web Worker. Consume 16 KiB decoded slices and await each persistence request before continuing. The API caps both actual request bytes (1 MiB) and records (1,000); the database independently validates the same limits, canonical units, current profile ownership and current ingestion consent. Source keys remain stable across re-imports. Each Apple device receives a separate source ID so simultaneous readings from different devices are not deduplicated against each other.

Apple HRV SDNN is not RMSSD, and basal energy is not total calories. Skip these unsupported types instead of relabelling them. Unsupported or invalid records are counted in the UI. Device identities exceeding the bounded 200-character format are skipped rather than truncated into potentially colliding identities. Source versions and transient HKDevice memory addresses are excluded from stable identity. Sources: [zip.js readers](https://gildas-lormeau.github.io/zip.js/api/classes/ZipReader.html), [Apple HRV SDNN](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/heartratevariabilitysdnn).

Successful metric inserts and affected local-day job revisions commit in one transaction. Duplicate-only batches do not enqueue new work. Jobs account for readings crossing local midnight, are RLS-protected and are not directly exposed to clients. M3 consumes them; the every-minute dispatcher remains M4.

Import requests have a 30-second deadline and at most three idempotent attempts, with bounded backoff for network/temporary service failures. Honour `Retry-After`; a long rate limit stops the import with a retry-later message. Access/consent denials are never retried. Distinct Playwright suites use separate artifact directories so parallel regression checks cannot remove a large-file fixture in use by another suite.

The CLI seed creates reserved-domain, explicitly marked synthetic accounts without emailing anyone. It uses the same adapter normalisation and checked ingestion functions as user imports. The large-file verification uses a compressed ZIP containing at least 210 MiB of real XML quantity records (6,000 distinct readings repeated to exercise overlap/deduplication), not ignored padding, and imports it twice against Supabase. Memory verification samples the sum of all renderer-process RSS in a dedicated Chromium instance, including its dedicated worker and native allocations, without subtracting idle memory.

## D007 — Explainable, local-calendar analytics

Analytics are pure functions. Missing values stay null, not zero. Baselines use one daily observation across the prior 28 calendar days, excluding the day being scored; gaps and DST do not become fabricated readings. Recovery/readiness is a non-clinical, equal-weight mean of three bounded 0–100 components: `100 - 500*(RHR/baselineRHR - 1)`, `100 + 250*(HRV/baselineHRV - 1)`, and `100*sleep/baselineSleep`. Require all three inputs and at least seven prior observations for each. Persist inputs, components, baseline values/counts and the reason for a missing score. Readiness uses this same explainable index, not an additional opaque model.

Select a primary source per metric/local day, preferring real readings, then greatest duration/sample coverage and a stable ID tie-break, to avoid double-counting co-worn devices. Preserve all raw source readings and the selected source IDs. This can undercount a day split between devices; the UI must disclose source selection. Merge overlapping sleep intervals, subtract explicit awake intervals, and prorate totals crossing midnight. Nightly SpO2 uses an explicit local 22:00–09:00 window, not inferred sleep detection.

Cycle estimates require a recorded period anchor. Preserve manual and imported period provenance separately from inferred phases; never treat old generated phases as user-entered anchors. Require three consecutive temperature-rise days plus resting-heart-rate rise to estimate a luteal shift. No anchor means unknown. Display the planning/energy estimate disclaimer, never fertility or contraception claims. Every insight retains evidence, confidence and the doctor-discussion footer; nutrition suggestions are low-confidence and contain no purchase links.

Summary processing claims durable jobs with short `SKIP LOCKED` transactions and random lease tokens, then rechecks ingestion consent under the same profile-first lock order as ingestion. It coalesces at most seven nearby pending days; retries fall back to one day. Historical changes also recompute the following 28 days' derived scores. Results, audit entries and processed revisions commit atomically. Expired workers cannot overwrite a newer lease; failures retain safe error codes and durable backoff. Each dispatcher run is bounded; the every-minute route remains M4.

Verification exposed UTC-based sample readings spilling onto an extra local day. Generate the last 90 complete days in the profile's timezone instead. Seed version 2 regenerates only the three explicitly marked synthetic fixtures, refuses profiles with uploads/documents/consults/manual cycle logs, and retains their profile IDs. Synthetic readings are reproducible with `npm run seed`; no uploaded health data is removed.

## D008 — Alert evidence, consent and delivery guarantees

Evaluate default/owner-overridden rules in the summary transaction, separately for each source. Ordinary heart rate requires explicit `at_rest` context; never infer rest merely from a low heart rate. Resting-heart-rate records already carry that context. The temperature rule means Celsius above the prior baseline, not MAD units. Baseline-dependent rules need at least seven prior daily observations. Interpret the BP threshold as either user-entered systolic ≥180 or diastolic ≥120. The ingestion boundary rejects future timestamps and unfinished measurement intervals, with a device-clock/retry message; an import describes completed evidence, not a promised future interval. The pure evaluator also clips evidence to its explicit clock. Record the peak reading's actual timestamp in the exact alert template.

Overlapping detections extend an existing continuous episode rather than generating repeat notices. Keep historical readings visible, but real events ending more than 24 hours before processing do not send notifications or start escalation. Sample events remain explicitly labelled and always use stub delivery, even if email keys are present. Rule edits cancel pending notices under the old threshold; previous alerts remain historical evidence.

In-app alerts are always persisted while ingestion consent is active. Add separate recorded `alert_email` and `emergency_contact` consents. Changing a contact invalidates forwarding consent. A caregiver needs a current accepted alerts scope, the patient's sharing consent and the recipient's email opt-in. Recheck acknowledgement, ingestion consent, current rule enablement, recipient identity and current access immediately before every send. A notification already handed to an external provider cannot be recalled by a subsequent revocation.

Urgent deadlines are stored as processing time +15 minutes. A private RLS-protected outbox has unique recipient keys, short lease claims, frozen retry payloads, bounded backoff and fenced completion. Resend calls carry a stable delivery idempotency key; stop automatic retries after eight failures or 23 hours from the first attempt, inside Resend's documented 24-hour window. This prevents an ambiguous late retry from becoming a duplicate email; exhausted work needs operational review. Stubbed delivery is not recorded as a real contact notification. Doctor escalation remains a user-initiated urgent-review offer, not an automatic consult or a claim that a doctor was notified.

`/api/jobs/tick` accepts an exact server-only bearer secret of at least 32 characters. It prioritises escalation/delivery, then bounded summary batches. Supabase Cron setup stores the endpoint/secret in restricted Vault, references them from a one-minute `pg_cron`/`pg_net` job, and verifies the configured cadence. Do not activate it against localhost. The deployed URL/secret are needed at M7; until then use the CLI and protected-route tests. The Vercel example is only a same-cadence fallback, not enabled automatically.

The browser service worker never caches health data or auth responses. Chrome registration and a local test notification are implemented; server Web Push, SMS and WhatsApp remain explicit stubs without configured delivery infrastructure. The local test is not presented as a server push-delivery test. Console email stubs log only a delivery ID, not recipients or health values.

Sources: [Supabase pg_net/Cron](https://supabase.com/docs/guides/database/extensions/pg_net), [restricted Vault secrets](https://supabase.com/docs/guides/database/vault), [Resend idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys). Use current extension defaults; do not pin extension versions or directly update `cron.job`.

## D009 — Golden paths follow their feature milestones

The founder explicitly approved retaining milestone order and gating each golden path when its features exist. The original requirement to run every path at M5 conflicted with doctor/guardian features in M6 and export/deletion in M7. Gate paths 1–2 at M5; add paths 3–4 and 6–7 at M6; require all seven, including path 5, at M7. Keep already-enabled paths passing and run the complete suite twice at M8. No golden path is removed or weakened.

## D010 — Patient UI, private navigation and current PWA checks

Keep the existing Next.js/npm project on Vercel and Supabase. Apply the Sites skill's accessible, mobile-first working-surface guidance, not its Cloudflare hosting defaults. The scaffold has no installed shadcn components; native form controls and shared CSS cover this milestone without a second UI runtime. Three main tabs remain Today, Doctors and History. More holds configuration. Doctor actions remain explicitly unavailable until M6, not fake successful requests.

Onboarding has four screens. The account's adult DOB is checked again on identity edits. Choose the history timezone before ingestion; changing it after readings exist is explicitly unavailable in this version rather than silently regrouping an existing history. Country codes IN/US/GB/AE map to 112/911/999/998 respectively; other countries use the non-numeric “your local emergency number” wording until verified mappings are added. Sources: [India ERSS](https://112.gov.in/), [US 911](https://www.911.gov/calling-911/), [UK emergency numbers](https://www.gov.uk/guidance/999-and-112-the-uks-national-emergency-numbers), [UAE health services](https://u.ae/en-GB/information-and-services/health-and-fitness).

Today shows one priority card, up to three persisted insights, then the doctor action. Sample provenance is visible. Cycle estimates require an explicit display opt-in; switching it off hides cycle insights/shading without deleting existing history. The period form records a manual anchor and queues recalculation. All-history access uses keyset pages of up to 365 recorded days; raw records, alerts, documents and sources also have bounded pages. Charts break at missing dates/values, show daily source provenance, and retain acknowledged alert markers. Source inspection is individually scoped and audited, independent of source-list pagination. Private tab navigation uses full page loads to recheck current access.

An authenticated owner can request bounded processing of only their own profile's durable jobs while viewing Today. The processor rechecks live ownership under its profile lock. This is an interactive convenience for imports/local demos, not the escalation scheduler: queued work remains in Postgres and production minute cron continues independently of the browser.

Chrome has deprecated Lighthouse's PWA category. Verify the same installation requirement through Chrome's current `Page.getInstallabilityErrors`, the actual manifest/icons and active service worker, rather than claiming a removed Lighthouse audit ran. Keep health data, Auth and API responses out of service-worker caches; an internet connection is required. Source: [Chrome's Lighthouse installability documentation](https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest).

## D011 — Care-team consent and contact discovery

Reuse the existing checked, audited database operations and stable health-profile IDs. A verified doctor can read only currently shared scopes; requesting a consult does not silently broaden them. Credential edits return a doctor to pending verification. Only an existing database-admin role can verify a doctor, never signup metadata. Seed doctors are explicitly labelled Sample data and are not presented as real practitioners or bookable clinical services.

Caregivers exchange their account code while signed in. The patient/guardian enters that code and chooses read-only scopes; the recipient must accept inside their own account. A code is an identifier, not a bearer access token. This avoids exposing an email-search directory or claiming that an invitation email was delivered while email infrastructure is unconfigured. Alert forwarding additionally requires the existing patient sharing consent and recipient email opt-in. Pending invitations reveal only the inviting profile's name and selected scopes, and that read is audited. Revocation takes effect on the next authorised request; already downloaded copies cannot be recalled.

## D012 — Clinical snapshots and server-rendered PDFs

Use `@react-pdf/renderer` in a Node route handler. It fits Vercel without a second headless-browser deployment; the PDF skill's render-to-PNG/visual-verification process still applies. Generate the one-page report from bounded 30/90-day daily aggregates, not raw imported records. A doctor with `summary_only` can see these trends, aggregate alert counts, listed documents and self/guardian-reported medications in the clinical summary, but cannot open raw History or the separate alerts feed without its scope. Ordinary caregivers do not gain a clinical-PDF endpoint through summary access.

The patient or guardian creates an immutable summary snapshot; consults attach its ID, and the current authorised doctor can download it. Every non-self summary read is audited. Preserve the snapshot's generation date, sample label and guardian-consent provenance. A downloaded PDF cannot be remotely revoked. Missing measurements and unrecorded medications are labelled, never inferred. Sources: [React PDF Node API](https://react-pdf.org/docs/v4/node), [Supabase function privileges](https://supabase.com/docs/guides/database/functions).

The renderer's language packages expose ESM-only entry points. Declare the existing import-based project as `type: module` and use the default CommonJS interop import for `@next/env` in CLI scripts. Drizzle's configuration loader uses Node's native `process.loadEnvFile` to avoid mixed-module interop. Verify existing commands after this change rather than patching installed packages. Keep the report one page with six daily-aggregate charts. Store up to twelve reported medications; the PDF lists the first six in full and prominently counts any omitted entries. List six recent document titles with remaining-document counts and visibly shortened names/titles. The app retains the complete entries. Never silently truncate medication names or doses to fit the PDF.

Embed static OFL-licensed Noto Sans and Devanagari fonts locally; patient text is never sent to a font service. Check glyph coverage before rendering and decline unsupported scripts/emoji with an explicit error, leaving the complete HTML summary available (OQ006). Measured, grapheme-preserving line breaks keep long identifiers on the page. Verify both normal personas and hostile-width/multilingual fixtures visually, not just their page count. Source: [React PDF fonts](https://react-pdf.org/docs/v4/fonts).

## D013 — Explicit adult ownership transfer

At 18 or later, the owning guardian offers conversion to the dependent's confirmed adult account code. The recipient must sign in and accept ownership, processing consent, the disclaimer and replacement of their empty signup profile. The recipient's recorded DOB must match the dependent's. Refuse replacement if that account already has health data, consents, sharing links, consults, a doctor role or owned dependents; never merge or erase another established history. Both sides can abandon an unaccepted offer, and offers expire after seven days.

Transfer atomically under ordered profile locks. Keep the dependent's stable profile ID, history, snapshots and historical consent provenance. Retire mandatory guardian authority, revoke previous sharing and outstanding notification work, cancel open consults and clear the old emergency contact. The new adult gives fresh processing consent and chooses their own future sharing/contact consents. Keep a recorded offer/acceptance audit. The production API uses the database clock only; controlled-clock testing calls a private helper that is not executable by application roles. This implements account control and consent recording, not legal verification of parental authority (OQ001).

## D014 — Data rights and private document lifecycle

Export only profiles owned by the authenticated account, including its current dependents, never patients merely linked to a doctor or caregiver. Stream a ZIP with per-metric CSVs, profile records and original documents; do not buffer an entire health archive in a server function. Downloads are private and cannot be remotely recalled.

Keep clinical documents in a private Supabase bucket, accessed through checked and audited application routes. No public or durable signed download links. Limit each uploaded PDF/JPEG/PNG to 3 MiB, below Vercel's request-body limit; the large Apple archive remains a separate browser-streaming workflow. Use the Storage API for actual file deletion, not SQL deletion of Storage metadata. Sources: [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [object deletion](https://supabase.com/docs/guides/storage/management/delete-objects).

Account deletion is an explicit, retryable request with a private database fence. Freeze new account work and sharing, remove the exact owned document prefixes through Storage, then hard-delete owned health profiles/rows and anonymise audit references before deleting Auth. Record intermediate completion so a failed external call never becomes a false success and can be retried. A successful response means the operation completed within that request; it is not a promise that provider backups have been purged.

Deleting a doctor account must not cascade-delete another patient's consultation history. Nullable, anonymised doctor/message-author references preserve patient-owned notes; cancel unfinished consults and remove account identifiers. Historical guardian consent on an already transferred profile keeps its authority, date and policy but loses the deleted grantor identifier and IP hash. These are application data-ownership safeguards, not a claim of approved medical-record retention policy; launch retention and legal copy require counsel review.

## D015 — Honest pharmacy links and preview legal notices

Pharmacy is a manually entered search under More only. No insight purchase links, inferred prescriptions, inventory, price or partner API. `getProduct()` returns null until a real authorised integration exists. The Tata 1mg query deep link was verified against its public search results on 8 September 2026. Apollo 24|7's medicines link redirects to Apollo Pharmacy; its working public search route is `/search-medicines`, but typing/confirming a query did not expose a shareable query URL. The Apollo stub opens that verified route and explicitly asks the user to re-enter their term, rather than fabricating query-prefill support. External links suppress the referrer and never attach HMS health records. No accounts, orders, agreements or partnerships were created.

Privacy/terms describe actual preview behaviour and mark unresolved operator, grievance, parental-verification, retention and cross-border clinical requirements as launch dependencies (OQ001/OQ007). They are not a compliance guarantee. Use the final DPDP Rules 2025 and check phased commencement/corrigenda with counsel before launch, rather than treating the January 2025 draft or every future obligation as already operative.

## D016 — Dated catalogue, not implied device integration

Seed 25 manufacturer-sourced devices across six categories, with a fixed 8 September 2026 verification date, including budget, mid-range and hyper-premium smart scales. `src/lib/devices/catalog.ts` preserves every row's primary source URLs and configuration caveats. Store only positively verified features; unknown local prices stay null, with “Check price” rather than an exchange-rate estimate. Display every numeric price with its date. Apple prices come from the four regional storefronts, not a currency conversion. WHOOP's displayed price is explicitly the first annual Peak membership including hardware, not a one-off purchase.

Filters combine all selected features, half-open local budget bands, screen preference and the advertised upper battery limit for the named configuration. Unknown price/battery values cannot satisfy those filters. Do not compare a CGM's disposable wear period or an Omron cuff's measurement count as rechargeable battery days. Oura's 6–9-day range and subscription, always-on/GPS modes and age/region restrictions are visible. The selected fēnix 8 and Ring AIR are not claimed to be the newest models. Manufacturer features are not HMS import compatibility; Apple HRV SDNN is never relabelled as RMSSD.

The public comparison reads `device_catalog` through the existing publishable-key client and RLS. The idempotent administrator seed upserts only the named rows, preserves unrelated entries and verifies the values again as `anon` inside its transaction. The live catalogue browser test belongs with credential-dependent golden tests; ordinary CI browser checks remain independent of a hosted database.

## D017 — M7 deployment fallback

Vercel CLI 59.11.7 `whoami` reports logged out. Follow PLAN's build-only fallback; do not log in, create a temporary deployment/account or upload environment secrets. Verify the production build locally with the browser suites. A real Vercel deployment, final Auth redirect allowlist, environment configuration and minute scheduler activation remain founder setup, not a completed public deployment.

**Superseded post-M8 for current status only.** The repository is now linked to a Vercel project (`.vercel/repo.json`, project `hms`, remote `origin`), and FINAL_REPORT.md records that the linked project and a production site exist. The logged-out build-only fallback above describes M7's evidence, not the present environment. Preview-environment parity remains unresolved (OQ011), the minute scheduler is still unactivated (OQ004), and no session has deployed, logged in or uploaded secrets on the founder's behalf.

## D018 — Uncertain clinical writes and bounded cursor validation

Reuse a component-lifetime request/message UUID when retrying unchanged content after an uncertain response. The existing database operations already check the UUID and matching payload. Clear a message draft as soon as its write is confirmed, independently of the subsequent view refresh. Keep drafts and retry IDs in memory only; after reloading, check saved consults/messages before composing another request. Changed content is a new operation, not a silent overwrite of an already saved clinical entry.

Validate doctor-portal URL cursors and care API cursors against complete UUID/timestamp shapes before database calls. Preserve Postgres microsecond timestamp strings. Malformed/repeated URL values render a controlled not-found page, and incomplete API cursors return a validation error instead of silently dropping a page or throwing a server error.

## D019 — Progress-aware live import verification

The large-file regression previously imposed an undocumented 400-second limit per import. M8 observed an otherwise error-free re-import still advancing at 570,000 of 620,285 records when that deadline expired; its measured memory peak was 235,601,920 bytes. PLAN's requirement is a ≥200 MiB streamed fixture, bounded batches, ≤512 MiB memory and exact deduplication, not a fixed remote-service throughput. Allow fifteen minutes per pass and a 35-minute test envelope for setup/cleanup, while retaining a stricter two-minute no-progress watchdog and minute-by-minute counters. The initial ten-minute allowance proved too short when an uninterrupted, progressing re-import reached 511,000/620,285 records before failing at 600,216 ms. Keep every byte, memory, record, worker and deduplication assertion, and all production request/retry deadlines unchanged. Timed-out runs remain failed evidence, not passes.

## D020 — Browser-only health CSV folder imports

Accept a recursively selected folder of up to 20,000 CSV files without uploading the source files or adding a server worker. Sort and stream files sequentially in the existing browser Web Worker, reuse one root data source and preserve the existing ≤1,000-record/≤1 MiB API boundaries. Auto-detect the HMS four-column schema, legacy Google Fit Daily activity metrics, and the canonical `Physical Activity_GoogleData` files in Google Health/Fitbit Takeout. Map only fields with exact semantics in the existing vocabulary: heart rate, resting heart rate, steps, active/total calories, RMSSD HRV, SpO₂, respiratory rate, skin temperature and weight (grams converted to kilograms). Use the profile timezone for date-only rows and preserve explicit offsets for interval rows. Prefer Google's consolidated legacy file over date-named siblings; for Google Health, consume the canonical physical-activity files rather than duplicating friendly summary folders. Report and skip account/settings files, empty datasets and unrelated schemas with bounded diagnostic names; fail malformed recognised files rather than guessing. Re-importing the same folder/source remains idempotent at the database boundary.

## D021 — Wearable account connection boundary

Treat hardware compatibility, file import and live account linking as different claims. Google Health is the live OAuth boundary for Fitbit Air, Fitbit, Pixel Watch and supported third-party data because the legacy Google Fit REST API is deprecated and the legacy Fitbit Web API is being retired. WHOOP uses its read-only OAuth scopes. Request only activity, measurements, sleep, paired-device and recovery-related read scopes; keep provider client secrets server-side and encrypt access/refresh tokens with AES-256-GCM in `hms_private.integration_connections`. That table has forced RLS, no client grants, an owned-profile foreign key and a cascading source relationship. The current signed-in account and live ingestion consent are rechecked before starting, completing and syncing a connection. Initial and manual syncs pull a bounded latest seven days through the same canonical metric validation, deduplication and summary-job boundary as file imports; rotating WHOOP refresh tokens are replaced atomically.

Apple HealthKit is an on-device iOS/watchOS API, not browser OAuth, so Apple Watch remains supported through the existing streamed Apple Health export unless HMS later ships a native iOS bridge. Garmin Health API and Ultrahuman partner data require vendor approval; expose those states honestly and retain adapter boundaries, but do not simulate a successful link. Other wearables can enter through Apple Health, Google Health/Takeout or supported CSVs. This stays entirely within the existing Vercel, Supabase and browser architecture.

## D022 — Local test login remains a real session

Show “Continue as test user” only under `next dev` and accept its POST only when `NODE_ENV` is development, the request URL is loopback and Origin exactly matches. The route uses the server-only Supabase secret to generate a magic link for one reserved test identity, then redeems its token hash through the existing SSR client so normal signed cookies, profile ownership and RLS remain in force. It sends no email and completes only that synthetic profile's onboarding fields. Production hides the control and returns 404 from the endpoint; this is test convenience, not an alternative production authentication method.
## D023 — Number not used

No decision was recorded under this number. The gap is kept deliberately so existing references to D024–D027 in PROGRESS.md, FINAL_REPORT.md and README.md stay valid.

## D024 — Live device ingestion and notification latency

HMS reacts immediately after data arrives, but does not claim to control a wearable's sensor or cloud-upload cadence. Fresh authenticated ingestion and direct account sync use a bounded inline fast path to recompute the latest affected day, evaluate alerts and drain the durable notification outbox; the every-minute pg_cron/Vercel route remains the retry and polling fallback. Connected browsers receive PHI-free private Supabase Broadcast invalidations and re-read the authorised, audited patient view. Web Push payloads also contain no health measurements and only deep-link back to HMS.

Do not apply a fixed rate-of-change alarm or clinical fever cutoff to wearable skin/wrist temperature. It is not core temperature and can be affected by environment, fit and physiology. Alert on both high and low sustained personal outliers only after at least seven baseline days: the conservative default is four median absolute deviations for 30 minutes. Treat this as an unusual-pattern prompt and ask the user to confirm with a clinical thermometer, never as a fever diagnosis.

The catalogue separately records device features, current HMS connection path, expected source delay and whether a vendor-approved live stream is technically possible. “Near real-time” starts only after phone/cloud sync; it is not sensor telemetry. Oura documents webhooks at about 30 seconds after app sync, Garmin cloud APIs wait for Garmin Connect while its licensed native SDK can stream supported sensors, and WHOOP's public API supplies event updates rather than continuous heart rate. Vendor webhooks are preferred, polling is rate-limited and partner-gated, and native HealthKit/Health Connect/Garmin sensor streaming still requires a future native companion or licensed SDK.

Treat delivery as four explicit service classes: live native/SDK streaming, near-real-time cloud events, periodic derived summaries, and manual imports. Classify individual metrics as well as devices because one device can expose intraday heart rate but only daily HRV, SpO₂ or temperature derivations. The product target is immediate processing and at most one minute of HMS-side scheduling after a provider exposes a reading; it is not an end-to-end guarantee over the vendor-controlled device-to-phone-to-cloud leg.

Every metric stores both its source `recorded_at` and immutable server `received_at`. Use their difference to measure source latency by provider, device and metric before publishing a delay claim. A future native companion must send normalised batches through the existing consent-checked ingestion contract, preserve the device timestamp and stable source identity, and remain replaceable by cloud or import adapters. Do not move alert policy, caregiver routing or clinical history into platform-specific mobile code.

## D025 — Monitor-authored thresholds and delivery visibility

An owner, ordinary caregiver or verified doctor may create a patient-specific numeric monitoring rule only while they hold current alert scope; non-owner access also requires the subject's live sharing consent. Guardian authority is represented as ownership, so a dependent cannot revoke it. A monitor rule never overwrites the app's recommended defaults and notifies only the profile owner plus its author through their enabled channels. Permission is rechecked during evaluation and immediately before delivery. Losing scope, relationship or sharing consent disables the affected rules and cancels pending deliveries.

Apply metric-specific storage bounds as corruption and input-error safeguards, not as claims that every allowed value is clinically appropriate. Wearable skin temperature remains baseline-deviation only. Categorical stages and flows are not numeric threshold rules. The UI labels presets as illustrative and tells people to agree targets with a clinician. Recent delivery activity exposes recipient labels and state without email addresses, push endpoints or payload secrets; a non-owner sees only the profile owner's and their own delivery rows. HMS latency starts when a reading is received, while device-to-phone-to-provider delay remains vendor-controlled.

## D026 — One native ingestion contract, two platform implementations

HealthKit and Health Connect companions use the same versioned, canonical HTTPS contract instead of placing alert or analytics policy in mobile code. A native app authenticates with its normal Supabase user access token; the server validates that token with the publishable-key client and never embeds a Supabase secret or database credential in the binary. Cookie-authenticated web mutations retain same-origin protection, while bearer-authenticated native mutations rely on the validated bearer credential and the same database ownership, consent and RLS functions.

Represent a native installation as an `aggregator` data source with tightly validated private metadata until a provider-enum migration is materially useful. Its stable installation ID is random and contains no hardware serial, advertising ID or patient data. Each native batch has a client-generated UUID and an immutable content fingerprint. Exact retries return the original result; reusing an ID for different content fails. The normal metric uniqueness constraint remains the second idempotency boundary.

Do not claim a native app is shipped merely because its server protocol exists. A production iOS/Android client additionally requires full platform toolchains, signed entitlements, store privacy declarations and physical-device background-delivery tests. Queue contents must be encrypted with a Keychain/Keystore-held key, and notification payloads remain free of health values.

## D027 — Measure latency and describe missing data honestly

Expose an audited, full-history-scoped report that aggregates the last 30 days of `recorded_at → received_at`, alert creation and completed delivery timing. Show median and 95th percentile separately by source and metric. Mark continuous sources delayed after three configured source intervals with a minimum five-minute grace period; manual imports never pretend to be live.

A delayed or absent feed is an operational state, not evidence that the person slept, did not sleep, fainted or is otherwise unwell. HMS may notify about feed health only with copy that says data stopped arriving. Clinical and monitor-authored thresholds continue to evaluate actual received measurements. This avoids converting permission, battery or connectivity failures into false medical claims.

## D028 — Chart band, boundary split and marker semantics under the locked design system

The History chart's "usual range" band is the rolling 28-day median ± 3 MAD of the metric's daily values, recomputed per visible day from every daily row the page has loaded (shorter ranges keep earlier rows as baseline source rather than pretending the baseline is empty). Three MADs is roughly two standard deviations, so a line leaving the band is "unusual for you" while alert rules still fire at four MADs. The band appears only once seven daily values exist in the window and is drawn as a dashed `--rule` outline with the "Building your baseline" count until 28 exist, in line with DESIGN.md §5.4. Bars start at zero; lines do not.

The polyline is split at the exact crossing of the band edge (linear interpolation of both the value and the moving edge), never recoloured whole. Alert markers are 2px `--urgent` notches on the axis for every severity, as §5.5 requires; the acknowledged state is carried in the marker's accessible name and title rather than by a second colour. Chart geometry lives in `src/lib/patient/chart.ts` as pure functions; the shared `DataChart` component measures its container and rebuilds the geometry at the rendered width so axis text stays at the axis size on every viewport.

No existing test assertion changed for this pass; new unit tests cover the band threshold, the boundary split, the text alternative and bar rendering.

## D029 — Freshness line source and the screen sweep

The Today freshness line (DESIGN.md §7.5) reads `computed_at` from the newest daily summary, which the patient view already returns and the client schema previously discarded. No column, RPC or scope changed; a summary is recomputed whenever readings land, so its timestamp is the honest "synced" moment available to every reader of Today, including summary-only caregivers. Readings older than six hours switch the dot to `--ink-soft` and the copy to "Last synced" with the time in the profile's timezone; with no summary at all the line says "Not synced yet" rather than disappearing.

Today follows the reference screen rather than the earlier single hero card: a resting-heart-rate card with the serif number, one sentence against the 28-day band and a 30-day sparkline; a Sleep card with bars and the baseline count; then the alert card in its §6 treatment, the insights and "Talk to a doctor". The 30 daily rows come from the existing history view section, read client-side, so a summary-only caregiver, who cannot read history, keeps the single-value hero. The `today-hero` test hook sits on the alert card when an alert exists and on the resting-heart-rate card otherwise, and the existing golden assertions were not changed.

Every route now uses the shared primitives rather than ad-hoc utility borders and fills. Link rows no longer append an arrow glyph (§12). The three DESIGN.md densities are not implemented because no mode exists in the product (OQ014).

## D030 — Founder override: Apple-like rounding and a floating tab bar

On 11 September 2026 the founder reviewed the locked system in the browser and asked for Apple-style curvature. DESIGN.md §4.7 (4px inputs, 12px cards, 20px sheets) and §7.4's full-width tab bar are superseded by this decision: inputs and chips 10px, buttons 14px, cards 20px, sheets and the tab bar 28px, with `corner-shape: squircle` on every rounded surface so browsers that support continuous corners draw them and others keep circular arcs. The tab bar floats as an inset island above the safe area, separated from content by the hairline and the lit top edge rather than a shadow, so §4.7's no-shadow rule still holds. Colour, type, spacing, chart language and alert treatment are unchanged. Update DESIGN.md §4.7 and §7.4 to match before the next design pass.

## D031 — Three densities, one system; copy without meta strings; hatch approved

The founder asked on 11 September 2026 for DESIGN.md §9's Simple, Standard and Advanced densities to exist. Density is a per-profile column (`profiles.display_mode`, default `standard`, migration 0035 with a check constraint) written only by the owner through the existing `hms_profile_settings` function's new `display` action, chosen in onboarding step 1 and changed under More → Display. The patient view exposes it (migration 0036) so a doctor or caregiver sees the viewed profile's density. The frame sets `data-mode`; CSS scopes the differences: Simple raises body text to 19px and every target to 48px, Advanced drops card padding to 12px and floors label and axis text at 15px. Simple Today shows the hero metric, the alert if any and enough insights to make three cards, with no raw value lines; Simple History is one sparkline card per metric. Advanced History overlays up to three further metrics on their own scales, told apart by weight and dash, shows the numeric usual range with its day count, discloses the formula, and nests the daily table with its source in a `--surface-2` panel. Navigation, alert copy, legal copy, colour roles, chart language and the accessibility floor are identical across the three.

Middle-dot meta strings in interface copy were rewritten as sentences or comma lists per DESIGN.md §12. Data-driven labels such as the simulator's "Sample data · b" source name are unchanged. One golden assertion on the doctor's consult queue link text was updated to the new wording. The founder approved the hatch treatment for cycle phases, closing OQ013. The founder also preferred the reference HTML's dark urgent red, but it fails the 4.5:1 floor on `--surface-2`, so DESIGN.md's value stays (OQ014). The "Live updates connected" line on Today was removed; the freshness line now carries that meaning, and only an interrupted connection is still announced.

## D032 — Post-import timezone changes are re-bucketed, not refused (OQ005)

The founder asked on 11 September 2026 for post-import timezone changes to work. `metrics.recorded_at` is `timestamptz`, so raw readings are absolute instants and never move; only derived, day-keyed rows do. Changing the home timezone therefore re-enqueues every affected local day through the existing durable `summary_jobs` queue rather than raising. Migration 0037 adds `profiles.previous_timezone`, `profiles.timezone_changed_at`, `summary_jobs.rebucket` and `summary_snapshots.timezone`; `hms_private.change_timezone` performs the change and `hms_private.enqueue_rebucket` queues the span of days with a two-day margin, which covers the widest possible offset difference (-12:00 to +14:00 exceeds one calendar day) so days that existed only under the old zone are recomputed and emptied too. The `identity` action routes into the same path, so the existing edit form triggers a re-bucket instead of failing. The queue is drained by the owner-driven `/api/patient/refresh` batches that already serve import, so this does not depend on the undeployed minute scheduler (OQ004).

The founder chose to re-evaluate past alerts under the new zone. `persistAlerts` already marks any event ending more than 24 hours ago `is_historical` and writes no delivery rows, so re-evaluation cannot produce a notification burst. `persistAlerts` only inserts and extends, so the processor first prunes alerts the new day boundaries no longer produce. That prune is deliberately narrow: unacknowledged, not escalated to a contact or doctor, not yet escalation-processed, and ending more than 24 hours ago. Acknowledged and escalated alerts are kept because the patient has already acted on them, and the 24-hour floor matches the historical cut-off so nothing with a pending delivery is deleted and re-created.

The founder chose stale-but-labelled over blocking. History and Today show a `RebucketNotice` with the remaining day count, and the patient view returns `stale_days` so each day still queued is badged "Awaiting recalculation" rather than hidden. Summary snapshots stay immutable: migration 0039 records the timezone each was computed in and `hms_private.clinical_summary` returns `timezone_changed` when the patient has since moved, so a doctor reading a shared snapshot is told its days no longer match the live history instead of seeing an unexplained discrepancy.

## D033 — Doctor alert list follows §6; consult chat gets a live channel that nothing depends on

The founder asked on 11 September 2026 for the doctor's shared alert list to use the DESIGN.md §6 rule and for consultation chat to be realtime.

The alert list now renders the §6 card: the 2px top rule, the icon and the bold label, urgent in `--urgent` and everything else in `--ink-soft`, identical to Today. It stays read-only; only the patient or owning guardian can acknowledge.

Chat reuses the mechanism the patient view has used since migration 0024. Migration 0040 adds `hms_private.can_receive_consult_live`, whose participant rule is exactly the one `hms_private.consult_read` already enforces, a `realtime.messages` policy scoped to the `consult:<uuid>` topic, and triggers on `public.messages` and `public.consults`. The broadcast carries only a `changed` ping: no clinical text crosses the channel, and the client re-reads the thread through `hms_consult_read`, so participation and consent are re-checked on every refresh rather than trusted from the socket.

The original live ping did not reach the browser in the 11 September golden run, so the explicit Refresh messages button stayed as a recovery control. This verification status is superseded by D036; the channel design and fallback decision remain unchanged.

## D034 — Dark urgent is #F0554F; the contrast floor is unchanged

On 14 September 2026 the founder chose the reference HTML's dark `--urgent` `#F0554F`, closing the colour half of OQ014. It measures 4.87:1 on dark `--surface` and 4.34:1 on dark `--surface-2`. The 4.5:1 floor in §4.5 and §10 is not lowered. `--urgent` renders in exactly two places — the alert card's 2px top rule and its label, and the chart notch — and both sit on `--surface`, so the pairing that fails is one the product never draws.

`scripts/check-contrast.ts` therefore drops the vacuous `urgent on surface-2` row and gains a structural guard: it parses `app/globals.css` for rules whose background is `var(--surface-2)` and fails the build if any of them, or anything scoped under them, sets `color: var(--urgent)`. The guard was verified by injecting a violating rule and confirming a non-zero exit, then removing it. This keeps the rule enforced by the build rather than by a comment.

Darkening `--surface-2` so the old pair would pass was rejected. `#2A231D` reaches 4.51:1 against urgent but drops `--surface-2` to `--surface` separation from 1.12:1 to 1.08:1, which erases the nested panel that §9's Advanced density depends on.

## D035 — Scope confirmations: PDF scripts, caregiver invitations

On 14 September 2026 the founder confirmed two limits as deliberate rather than outstanding work. Clinical PDFs stay on Latin and Devanagari; unsupported scripts keep returning the explicit PDF-unavailable response with the complete HTML summary intact (OQ006). Caregiver invitations stay as account codes rather than delivered invitation emails at launch.

## D036 — Realtime invalidations are required on Today, History and consultation chat

All three live surfaces use authenticated private Supabase Broadcast channels carrying only a `changed` ping. The ping never contains health or consultation text; each client re-reads the authorised server view so current ownership, sharing consent and participant access are checked again. History now uses the same `useRealtimePatientView` hook as Today. The UI exposes connection state only through test attributes and the existing interrupted-connection message, preserving the locked copy.

The browser contract is a no-refresh assertion, not merely a successful WebSocket handshake. A live golden test waits for `SUBSCRIBED`, changes a daily summary and observes Today and History, then exchanges consultation messages between two authenticated browser contexts and observes each remote update. The Refresh messages control remains available as a recovery path when a connection is temporarily unavailable.

History invalidations retain the active date range and pagination cursor. Refreshed readings also replace their cached baseline values and selected-day details. Each subscription re-reads on join/rejoin and on the browser's online event, covering pings missed during an outage. Superseded requests are aborted; disposed effects cannot subscribe later or write stale responses. Browser offline events immediately mark the view disconnected instead of waiting for a WebSocket heartbeat timeout.

## D037 — Run Vercel functions alongside the Mumbai database

Production was using Vercel's Washington (`iad1`) default while Supabase is in Mumbai. Configure the single function region as `bom1` in `vercel.json`, for both production and isolated Preview, to remove unnecessary intercontinental database round trips. Keep the existing provider, free single-region plan, database location, job bounds and test deadlines. Next.js 16.3.4 deprecates `preferredRegion`, so use platform configuration rather than route exports. Deployment region and the full deployed golden suite must be verified before claiming the latency issue resolved.

## D038 — Resumable provider sync and explicit revocation state

Google Health and WHOOP filter by observation/session time, so a five-minute overlap can miss a phone's late upload or a later-scored sleep. Reconcile the latest seven days using a frozen window and a validated, private JSON checkpoint (migration 0041). Persist each page through canonical ingestion before advancing its checkpoint; interrupted writes replay safely through deduplication. Compare both the connection's encrypted-token version and expected checkpoint, and do not report a complete sweep while pages remain. The existing hand-authored private integration table is not part of the declarative Drizzle schema; this is a custom migration, not a second declaration of that table.

Runs have page and time budgets so history cannot monopolise the minute dispatcher. Dense histories can still take many runs. This correctness fix is not a measured one-minute service level; fair fresh-data/reconciliation scheduling, provider quotas and real-account load acceptance remain OQ012. Intraday Google heart rate retains its original observation time and unknown rest context; it is not relabelled resting heart rate.

Disconnect commits the local stop before contacting the vendor. A bounded revocation attempt runs outside patient/database locks; failure retains encrypted credentials only for retry and exposes a pending-removal state. A short lease and conditional completion prevent an old attempt from removing a replacement connection. Reconnect is blocked until pending removal is resolved; manual confirmation is explicitly labelled as removal performed in provider settings. Callback exchange and refresh serialise against disconnect so rotating credentials cannot escape the revocation snapshot. Previously imported history is retained.

## D039 — Configuration verification is not notification delivery

Add a redacted, read-only notification checker with an explicit environment-file option and no implicit local fallback. It validates VAPID key correspondence, contact and sender syntax; an optional GET-only Resend check verifies sender-domain metadata where the key permits it. Never broaden a sending key's permissions solely for this check.

Sensitive Vercel values are not downloadable, and its local environment runner may merge local credentials. The existing cron-authenticated tick route therefore accepts exactly one `check=notifications` query to inspect the deployed configuration without database access or dispatch. Invalid/duplicate diagnostic queries fail closed rather than falling into normal work. All diagnostics say that domain/inbox/physical-device delivery remains unverified. Real test messages require an agreed recipient and device; sample health alerts remain stubbed.

## D040 — Clinical-summary controls wait for hydration

A full navigation can render the clinical summary before its client event listeners attach. Snapshot, range and medication controls must remain disabled during that interval, then retain the existing busy-state guard. Use React's server/client external-store snapshots to represent hydration without a timer or changing summary, PDF, consent or audit semantics. The server-generated PDF link remains usable.

The doctor golden path now deliberately holds the page's JavaScript, asserts that those controls are disabled, releases the scripts and executes the existing snapshot/PDF/audited-scope assertions. No application or test deadlines are increased. This follows the [Playwright hydration guidance](https://playwright.dev/docs/navigations#hydration); retrying a click is not a substitute for making the initial UI truthful.
