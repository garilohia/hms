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
