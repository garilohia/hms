# Architecture decisions

These decisions incorporate the founder's answers on 8 September 2026. They are requirements for the forthcoming milestones, not a claim that those milestones are implemented.

## D001 — Adopt the existing scaffold

Keep Next.js 16.3.4, App Router, strict TypeScript, Tailwind, npm with `package-lock.json`, and the existing `utils/supabase/` helpers. Use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for public clients and keep `SUPABASE_SECRET_KEY` server-only. Complete the remaining M0 tooling and run `npx skills add supabase/agent-skills` at the end of M0.

Reason: the founder explicitly asked to adopt the working scaffold; recreating it or downgrading to the original plan's Next.js 15 would discard existing work.

M0 tooling: use Node.js 24 for CI and the documented runtime, npm 11.19.0, and Node 24 type definitions. The installed Vitest 5 requires Node 22.12+ and compatible types; the host's Node 26 also passed the checks. Source: https://vitest.dev/guide/.

## D002 — Browser-based Apple Health import

Run application compute entirely within Vercel, Supabase, and the user's browser. Do not provision a separate worker service.

The user selects `export.zip` locally. A browser Web Worker streams ZIP decompression and SAX-style parsing of `export.xml`, maps records through the adapter's `normalise()`, and POSTs bounded normalised batches to the ingestion API. Do not load the whole archive or XML into memory, or upload the archive to a server function. Use backpressure so parsing cannot accumulate an unbounded queue of pending batches.

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

Seed 20 manufacturer-sourced devices across six categories, with a fixed 8 September 2026 verification date. `src/lib/devices/catalog.ts` preserves every row's primary source URLs and configuration caveats. Store only positively verified features; unknown local prices stay null, with “Check price” rather than an exchange-rate estimate. Display every numeric price with its date. Apple prices come from the four regional storefronts, not a currency conversion. WHOOP's displayed price is explicitly the first annual Peak membership including hardware, not a one-off purchase.

Filters combine all selected features, half-open local budget bands, screen preference and the advertised upper battery limit for the named configuration. Unknown price/battery values cannot satisfy those filters. Do not compare a CGM's disposable wear period or an Omron cuff's measurement count as rechargeable battery days. Oura's 6–9-day range and subscription, always-on/GPS modes and age/region restrictions are visible. The selected fēnix 8 and Ring AIR are not claimed to be the newest models. Manufacturer features are not HMS import compatibility; Apple HRV SDNN is never relabelled as RMSSD.

The public comparison reads `device_catalog` through the existing publishable-key client and RLS. The idempotent administrator seed upserts only the named rows, preserves unrelated entries and verifies the values again as `anon` inside its transaction. The live catalogue browser test belongs with credential-dependent golden tests; ordinary CI browser checks remain independent of a hosted database.

## D017 — M7 deployment fallback

Vercel CLI 59.11.7 `whoami` reports logged out. Follow PLAN's build-only fallback; do not log in, create a temporary deployment/account or upload environment secrets. Verify the production build locally with the browser suites. A real Vercel deployment, final Auth redirect allowlist, environment configuration and minute scheduler activation remain founder setup, not a completed public deployment.

## D018 — Uncertain clinical writes and bounded cursor validation

Reuse a component-lifetime request/message UUID when retrying unchanged content after an uncertain response. The existing database operations already check the UUID and matching payload. Clear a message draft as soon as its write is confirmed, independently of the subsequent view refresh. Keep drafts and retry IDs in memory only; after reloading, check saved consults/messages before composing another request. Changed content is a new operation, not a silent overwrite of an already saved clinical entry.

Validate doctor-portal URL cursors and care API cursors against complete UUID/timestamp shapes before database calls. Preserve Postgres microsecond timestamp strings. Malformed/repeated URL values render a controlled not-found page, and incomplete API cursors return a validation error instead of silently dropping a page or throwing a server error.

## D019 — Progress-aware live import verification

The large-file regression previously imposed an undocumented 400-second limit per import. M8 observed an otherwise error-free re-import still advancing at 570,000 of 620,285 records when that deadline expired; its measured memory peak was 235,601,920 bytes. PLAN's requirement is a ≥200 MiB streamed fixture, bounded batches, ≤512 MiB memory and exact deduplication, not a fixed remote-service throughput. Allow fifteen minutes per pass and a 35-minute test envelope for setup/cleanup, while retaining a stricter two-minute no-progress watchdog and minute-by-minute counters. The initial ten-minute allowance proved too short when an uninterrupted, progressing re-import reached 511,000/620,285 records before failing at 600,216 ms. Keep every byte, memory, record, worker and deduplication assertion, and all production request/retry deadlines unchanged. Timed-out runs remain failed evidence, not passes.

## D020 — Browser-only health CSV folder imports

Accept a recursively selected folder of up to 20,000 CSV files without uploading the source files or adding a server worker. Sort and stream files sequentially in the existing browser Web Worker, reuse one root data source and preserve the existing ≤1,000-record/≤1 MiB API boundaries. Auto-detect the HMS four-column schema, legacy Google Fit Daily activity metrics, and the canonical `Physical Activity_GoogleData` files in Google Health/Fitbit Takeout. Map only fields with exact semantics in the existing vocabulary: heart rate, resting heart rate, steps, active/total calories, RMSSD HRV, SpO₂, respiratory rate, skin temperature and weight (grams converted to kilograms). Use the profile timezone for date-only rows and preserve explicit offsets for interval rows. Prefer Google's consolidated legacy file over date-named siblings; for Google Health, consume the canonical physical-activity files rather than duplicating friendly summary folders. Report and skip account/settings files, empty datasets and unrelated schemas with bounded diagnostic names; fail malformed recognised files rather than guessing. Re-importing the same folder/source remains idempotent at the database boundary.
