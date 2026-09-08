# PLAN.md — Health Management System (working name: HMS)

Read this file fully before writing any code. Then read AGENTS.md.
This is a single-session build. You have roughly 3 hours of autonomous work.
Optimise for a working, deployed, demo-able product with zero known bugs — not for breadth.

---

## 1. What we are building

A health management system that:

1. Pulls health data from any wearable or health device a user owns (smartwatches, bands, smart scales, later CGMs and BP cuffs) into ONE normalised, perpetual personal health history.
2. Turns that history into plain-language trends, baselines and alerts the user actually understands.
3. Lets the user share that history with a doctor based in India and consult them from inside the app.

Three target users, in priority order:

- **NRIs (Indians abroad)** who have money but not easy access to the kind of doctor relationship affluent Indians have at home. They want an Indian doctor who can see their data and talk to them remotely.
- **Indians in India** who want their own doctor to see real history and trends instead of a one-off reading in the clinic.
- **Anyone wanting non-obvious insights** from their data: cycle-phase inference from skin temperature for women, sleep–stress–recovery patterns, training readiness.

What is NOT new: wearables, dashboards, sleep scores. Do not over-invest in those.
What IS the product: the doctor layer, the NRI-to-India bridge, and a clean perpetual history.

---

## 2. Non-negotiables

1. **Simplicity.** Three main tabs only: **Today**, **Doctors**, **History**. Everything else lives under **More → Advanced**. If a screen needs explanation, it is wrong.
2. **No medical claims anywhere.** The app never says "you have X", never "diagnoses", never says it "detects emergencies". It says "your reading is unusual for you" and points to a doctor or local emergency services. Every insight carries a one-line "discuss with your doctor" footer. Supplement suggestions are phrased as "worth asking your doctor about", never as instructions.
3. **Security and privacy by default.** Row-level security on every table. Consent recorded before any data is ingested or shared. Audit log on every read of a patient's data by anyone other than the patient. Full data export and account deletion work end to end.
4. **Real data or clearly-labelled sample data. Never fake data presented as real.** The simulator is labelled "Sample data" in the UI at all times.
5. **Zero known bugs at stop.** If a feature cannot be finished bug-free in the time available, cut it and record it in OPEN_QUESTIONS.md. A smaller product that works beats a larger one that doesn't.

---

## 3. Stack (do not change without recording a reason in DECISIONS.md)

- **Existing Next.js 16.3.4 scaffold (App Router), TypeScript strict, Tailwind, shadcn/ui.** Adopt the current project and Supabase helpers; use npm and `package-lock.json`. Mobile-first. Ship as an installable PWA. See DECISIONS.md D001.
- **Supabase** (Postgres + Auth + Storage + RLS). Use the project credentials in `.env.local`. Region is ap-south-1 (Mumbai) — do not change.
- **Drizzle ORM** for schema and migrations. Migrations must be reproducible from scratch.
- **Vitest** for unit tests. **Playwright** for end-to-end.
- **Resend** for transactional email (stub with a console transport if no API key is present).
- **Vercel** for deployment (deploy at milestone M7; use `vercel` CLI, fall back to a build-only verification if login is unavailable).
- Application compute stays within Vercel, Supabase, and the user's browser. Apple Health parsing runs in a browser Web Worker. Supabase `pg_cron` calls an authenticated route handler every minute for summary recomputation and escalation, with Vercel Cron as fallback if it supports that cadence. No separate worker service. See DECISIONS.md D002–D003.
- No native mobile code tonight. Apple HealthKit and Google Health Connect require native apps and are explicitly OUT OF SCOPE for this session. Design the ingestion layer so a native Expo app can post to the same endpoints later.

---

## 4. Architecture

### 4.1 Data model (Drizzle, Postgres)

Keep names exactly as below so later work is consistent.

- `profiles` — stable health-profile id, optional authentication-account id, owning account id, profile kind (`self` | `dependent`), name, dob, sex_at_birth, height_cm, country_of_residence, timezone, emergency_contact (name, phone), local_emergency_number (derived from country), role (`patient` | `doctor` | `admin`). Patient-related `user_id` foreign keys below identify the health profile, separately from the authenticated actor. A dependent has no login account and is owned by their guardian. See DECISIONS.md D004.
- `consents` — user id (subject profile), granted_by (authenticated adult), authority (`self` | `guardian`), consent_type (`data_ingestion`, `doctor_sharing`, `marketing`), granted_at, revoked_at, policy_version, ip_hash. Preserve guardian provenance after conversion to an adult account.
- `data_sources` — user id, provider (`simulator`, `apple_health_export`, `fitbit_export`, `garmin_export`, `generic_csv`, `fitbit_api`, `aggregator`), status, last_sync_at, metadata jsonb.
- `metrics` — the core time-series. Columns: user_id, source_id, metric_type, value numeric, unit, recorded_at timestamptz, duration_s (nullable), quality (`raw` | `derived` | `user_entered`), external_id (for dedupe). Unique index on (user_id, metric_type, recorded_at, source_id). Partition-ready by month but do not partition tonight.
  - metric_type enum (start with these, extensible): `heart_rate`, `resting_heart_rate`, `hrv_rmssd`, `spo2`, `skin_temperature`, `respiratory_rate`, `steps`, `active_calories`, `total_calories`, `sleep_stage`, `sleep_duration`, `stress_score`, `weight_kg`, `body_fat_pct`, `blood_pressure_systolic`, `blood_pressure_diastolic`, `blood_glucose`, `vo2max`, `menstrual_flow`, `basal_body_temperature`.
- `daily_summaries` — one row per user per day: rhr, hrv_avg, spo2_min, spo2_avg, skin_temp_deviation, sleep_duration_min, sleep_efficiency, deep_min, rem_min, steps, active_calories, stress_avg, recovery_score, readiness_score. Recomputed by a job whenever new metrics land for that day.
- `baselines` — per user per metric_type: rolling 28-day median, MAD, sample_count, computed_at.
- `alert_rules` — system defaults plus per-user overrides. Fields: metric_type, comparator, threshold_type (`absolute` | `baseline_deviation`), value, min_duration_s, severity (`info` | `attention` | `urgent`), enabled.
- `alerts` — fired alerts: user_id, rule_id, metric snapshot jsonb, severity, fired_at, acknowledged_at, escalated_to_contact_at, escalated_to_doctor_at.
- `insights` — generated plain-language observations: user_id, category (`sleep`, `stress`, `recovery`, `cycle`, `activity`, `nutrition_ask_doctor`), title, body, evidence jsonb (which metrics, which window), confidence (`low` | `medium` | `high`), created_at, dismissed_at.
- `cycle_logs` — user-entered period start/end plus inferred phase per day, with `is_inferred` flag.
- `doctors` — profile id, registration_number, registering_council, specialities[], languages[], bio, consult_fee_inr, consult_fee_usd, available (bool), verified_at.
- `doctor_patient_links` — doctor id, patient id, status (`requested` | `active` | `revoked`), granted_scopes[] (`summary_only` | `full_history` | `alerts`), created_at, revoked_at.
- `caregiver_links` — patient id, caregiver id (an authenticated adult), role (`caregiver` | `guardian`), status (`invited` | `active` | `revoked`), granted_scopes[] (`summary_only` | `full_history` | `alerts`), invited_by (`patient` | `caregiver`), created_at, revoked_at. Ordinary caregivers see the patient's Today and History read-only within scope, receive alerts if authorised, and can be revoked instantly by the patient. A guardian owns/manages a dependent's data and grants consent on their behalf, has full scope and explicit management permissions, and cannot be revoked by the dependent. Every caregiver/guardian read writes to `audit_log`. Schema and ownership enforcement belong in M1; the shared doctor/caregiver/guardian UI belongs in M6. At age 18 or later, the guardian can initiate conversion to a normal account, retaining the same health profile/history and retiring mandatory guardian authority. See DECISIONS.md D004.
- `consults` — patient id, doctor id, type (`urgent_review` | `trend_review` | `second_opinion` | `follow_up`), status, requested_at, scheduled_for, completed_at, patient_note, doctor_note, attached_summary_id.
- `messages` — consult id, sender id, body, attachments[], sent_at, read_at.
- `documents` — user id, type (`lab_report` | `prescription` | `discharge_summary` | `other`), storage_path, uploaded_at, title, tags[].
- `device_catalog` — brand, model, category (`watch` | `band` | `ring` | `scale` | `bp_cuff` | `cgm`), price_inr, price_usd, price_gbp, price_aed, metrics_supported[], battery_days, has_ecg, has_skin_temp, has_spo2, has_hrv, has_screen, subscription_required, subscription_cost, source_urls[], last_verified_at, editorial_note.
- `audit_log` — actor id, action, target_user_id, target_table, target_id, at, metadata jsonb.

### 4.2 Ingestion layer

Define one interface:

```ts
interface DataSourceAdapter {
  provider: Provider;
  connect(userId: string, input: unknown): Promise<DataSource>;
  sync(source: DataSource): Promise<{ inserted: number; skipped: number; errors: string[] }>;
  normalise(raw: unknown): NormalisedMetric[];
}
```

Every adapter writes ONLY through `normalise()` → `metrics`. Dedupe on the unique index. Never write to `daily_summaries` directly; trigger the summary job instead.

Adapters to build tonight, in order:

1. **Simulator** — generates realistic 90 days of data for three personas: (a) healthy 34-year-old male, (b) 42-year-old female with a regular cycle so cycle inference can be demonstrated, (c) 61-year-old male with hypertension and one night of low SpO2 and one fever episode so alerts can be demonstrated. Deterministic given a seed. Labelled "Sample data" in UI.
2. **Apple Health export importer** — user selects `export.zip` locally. Stream decompression and SAX-style parsing of `export.xml` in a browser Web Worker; archives may exceed 500 MB, so never load the whole archive/XML into memory. Map HKQuantityType / HKCategoryType records through `normalise()` and POST bounded batches to the API with backpressure. The API validates records, ownership/guardianship, and consent before deduplicated persistence. Show progress, cancellation, and recoverable errors. Import requires the browser to remain open; safe re-import deduplicates existing rows. No server function receives the archive. See DECISIONS.md D002.
3. **Fitbit data export importer** — Google Takeout / Fitbit account export (JSON per day). Map heart rate, sleep, SpO2, skin temp, steps.
4. **Garmin Connect export importer** — account export ZIP (JSON). Map what maps cleanly; skip the rest and log counts.
5. **Generic CSV importer** — columns: `timestamp,metric_type,value,unit`. Download a template from the UI.
6. **Aggregator adapter (interface + stub only)** — for Terra / ROOK / Junction. Implement the interface with a clear TODO. Do not sign up for anything.
7. **Fitbit Web API (OAuth 2.0 PKCE) — STRETCH ONLY.** Attempt only if M0–M7 are complete and verified. Callback at `/api/integrations/fitbit/callback`. Read env `FITBIT_CLIENT_ID`. If absent, the UI shows "coming soon".

### 4.3 Analytics engine (pure functions, fully unit-tested)

All in `src/lib/analytics/`. No database access inside these functions; they take arrays in and return results out.

- `computeBaseline(values, windowDays=28)` → median, MAD, n.
- `detectAnomalies(series, baseline, rule)` → events with start, end, peak, deviation in MADs.
- `dailySummary(metricsForDay)` → the daily_summaries row.
- `recoveryScore(rhr, hrv, sleep, baseline)` → 0–100 with the three inputs shown; document the formula in code comments. Keep it simple and explainable.
- `inferCyclePhase(skinTempSeries, rhrSeries, hrvSeries, userLoggedPeriods)` → per-day phase (`menstrual` | `follicular` | `ovulatory` | `luteal` | `unknown`) with confidence. Method: user-logged period start anchors the cycle; the sustained skin-temperature rise of ~0.3 °C over 3 days plus RHR rise marks the post-ovulatory shift. When no period is logged, return `unknown` with a prompt to log one. Never claim fertility or contraceptive accuracy; label as "estimate for planning training and energy".
- `generateInsights(dailySummaries, baselines, cyclePhases)` → insights. Rules to implement:
  - Sleep: 7-day sleep duration below personal baseline by >45 min → "You've slept less than usual this week."
  - Stress/recovery: HRV below baseline for 3+ days AND RHR above baseline → "Your body shows signs of strain."
  - SpO2: nightly min below 92% on 2+ nights in a week → "attention" insight recommending a doctor review.
  - Temperature: skin temp deviation >+0.5 °C for 2+ days outside luteal phase → "You may be running a temperature."
  - Nutrition (ask-your-doctor category ONLY): persistent low energy proxy (low readiness + low HRV) plus low skin temp → "Worth asking your doctor about iron and thyroid." Poor sleep plus high stress → "Worth asking your doctor about magnesium." Each of these must carry `confidence: low` and the ask-your-doctor footer. Never link directly to a product purchase from these insights.
  - Cycle: on entering luteal phase → "Energy may dip over the next ~10 days; heavier training earlier in your cycle usually feels better." On entering follicular → the inverse.
  - Activity: 7-day steps <50% of 28-day baseline → gentle nudge.

### 4.4 Alerts

- Default rules (system): SpO2 < 90% sustained ≥ 10 min (urgent); SpO2 < 92% sustained ≥ 30 min (attention); resting HR > baseline + 4 MAD for ≥ 30 min at rest (attention); HR > 150 or < 40 at rest ≥ 5 min (urgent); skin temp deviation > +1.0 °C ≥ 2 h (attention); any user-entered BP ≥ 180/120 (urgent).
- Alert copy must follow this template exactly: "**Unusual reading:** [metric] was [value] at [time]. That's outside your normal range. If you feel unwell, call [local emergency number] or contact your doctor." Never use the words "emergency detected", "dangerous", or "diagnosis".
- Channels: in-app (always), email (Resend, stub if no key), push (Web Push — implement service worker registration and a test button; stub server if no VAPID keys), emergency contact (email now; SMS/WhatsApp are stubs behind an interface).
- Escalation: urgent alerts unacknowledged for 15 minutes → notify emergency contact (if consented) → offer one-tap "Request urgent review" to a linked doctor.
- Store deadlines and pending summary recomputations in Postgres. Supabase `pg_cron`/`pg_net` invokes an authenticated route handler every minute, with Vercel Cron as the same-cadence fallback. Process bounded durable work with overlap/retry protection; recheck acknowledgement, consent, and access before escalation. Do not depend on browser or in-process timers. See DECISIONS.md D003.
- Users can adjust thresholds under More → Advanced → Alert rules. Defaults are shown with "Recommended" label.

### 4.5 Doctor side

- Doctor onboarding: registration number + council + specialities; `verified_at` is set by admin only (seed one verified doctor and one pending).
- Doctor portal (`/doctor`): patient list, per-patient timeline (same History view the patient sees, read-only), alerts feed, consult queue.
- **Clinical summary PDF** — one page: patient basics, 30/90-day trends for RHR, HRV, SpO2, sleep, weight, BP; alerts in the period; medications/documents list; auto-generated with the date and the sentence "Generated from consumer wearable data; not a medical device." Patient can generate and share it; doctor can download it. Use `@react-pdf/renderer` or Puppeteer — pick one and record it in DECISIONS.md.
- Doctor-facing summaries and PDFs display "Consent given by guardian" when consent was granted on a dependent's behalf. Authorised guardians can generate and share their dependents' summaries.
- Consult flow: patient picks type → optional note → attaches current summary → doctor accepts/schedules → in-app chat → doctor writes note → consult closes → patient sees note in History. Video is out of scope; leave a "Join call" button that opens a placeholder Google Meet / Zoom link field the doctor can paste.
- Sharing scopes: patient chooses `summary_only` or `full_history` per doctor and can revoke instantly. Every doctor view of patient data writes to `audit_log`.

### 4.6 Device comparison (Marketplace → "Which device?")

- Seed `device_catalog` with at least 18 devices across budgets. Use web search to verify current prices and specs; record `source_urls` and `last_verified_at` for every row. Include at minimum: Apple Watch (latest two SE/standard/Ultra), Google Fitbit Air, Pixel Watch (latest), Fitbit Charge (latest), Garmin (Venu, Forerunner, Fenix — one each), Whoop (latest band), Oura Ring (latest), Samsung Galaxy Watch and Ring (latest), Amazfit (two models), Noise or boAt (one budget Indian model), Ultrahuman Ring, Withings scale, one smart BP cuff (Omron), one CGM (Abbott Libre).
- UI: filter by budget band (₹ / $ / £ / AED toggle), by "must have" metrics (skin temp, SpO2, HRV, ECG), by battery, by screen/no screen. Show a plain one-line editorial note per device. Show "Best for NRIs who…" tags sparingly.
- Every price must show its verification date. If a price cannot be verified, show "Check price" with the source link instead of a number.

### 4.7 Pharmacy / supplements

- Build a `PharmacyProvider` interface with `search(query)`, `getProduct(id)`, `deepLink(product)`.
- Implement `Tata1mgProvider` as a **stub** that returns deep links to Tata 1mg search pages (no API keys tonight; the partner API needs a signed agreement). Implement an `Apollo247Provider` stub the same way.
- Show pharmacy links ONLY inside a consult when a doctor has written a note, or under More → Pharmacy. Never surface a buy link inside an insight card.

### 4.8 UI

- **Onboarding (4 screens max):** who you are (name, DOB, sex, country) → connect data (upload export / try sample data) → emergency contact + consent → done.
- **Dependents:** under-18s cannot self-sign up; enforce this in the auth/server account-creation path. An adult guardian creates a dependent profile under their own account and grants consent before ingestion or sharing. Keep the dependent's health history separate from the guardian's. After the dependent turns 18, offer a guardian-initiated conversion to a normal account that preserves the history and consent provenance.
- **Today:** one hero card (readiness or the most important thing today), then at most three insight cards, then "Talk to a doctor" button. Nothing else.
- **Doctors:** your linked doctors, active consults, "Find a doctor" (list with speciality, language, fee, next available), "Request urgent review".
- **History:** metric picker chips (RHR, HRV, SpO2, Sleep, Temp, Weight, Steps, BP), one chart, range toggle 7/30/90/365/All, alerts overlaid as markers, tap a point to see the source device. Below the chart: documents (lab reports, prescriptions) in a simple list.
- **More:** Devices & data (sources, import, export, delete account), Which device?, Alert rules, Cycle tracking (opt-in), Pharmacy, Advanced (raw metric table, baselines, formulas explained), Legal.
- Copy style: short sentences, no jargon, no exclamation marks. British/Indian English spelling.
- Dark mode not required tonight.

### 4.9 Legal & compliance scaffolding (build these as real pages and real behaviour, not lorem ipsum)

- `/legal/privacy` — DPDP Act 2023 aligned notice: what is collected, purpose, retention, how to withdraw consent, grievance officer placeholder, data stored in India.
- `/legal/terms` — includes: not a medical device; not for emergencies; consults are provided by independent registered medical practitioners in India; the platform is a facilitator; jurisdiction India.
- `/legal/disclaimer` — shown once at onboarding and linked from every insight footer.
- Consent capture writes to `consents` with policy_version, subject profile, granting adult, and self/guardian authority. Verifiable parental consent is a pre-launch legal dependency; the exact verification method requires a lawyer and is tracked in OPEN_QUESTIONS.md OQ001.
- Data export: one click → ZIP of CSV per metric_type plus documents → emailed link (or direct download if no email key).
- Account deletion: hard-deletes metrics, summaries, documents, links; anonymises audit_log rows; completes within the request.

---

## 5. Milestones and definition of done

Work strictly in this order. Do not start a milestone until the previous one passes its verification. Commit after every milestone with the message `M<n>: <title>`.

| # | Milestone | Done when |
|---|-----------|-----------|
| M0 | Repo, tooling, CI | `npm run lint && npm run typecheck && npm test` pass on an empty-but-wired project; GitHub Action runs them on push; `.env.example` complete; README has a 5-line run guide; run `npx skills add supabase/agent-skills` at the end. Adopt the existing scaffold and Supabase helpers. |
| M1 | Schema, auth, RLS, audit | All tables migrated from scratch; Supabase Auth email magic-link works; minor self-signup rejected; separate guardian-owned dependent profiles and consent provenance implemented; RLS tests prove user A cannot read user B's metrics or dependents, and dependents cannot revoke guardian authority; audit_log written on doctor/guardian reads. |
| M2 | Ingestion: simulator + CSV + Apple Health importer | Three personas seedable via `npm run seed`; CSV upload round-trips; Apple Health ZIP containing export.xml of ≥200 MB imports through a streaming browser Web Worker without exceeding 512 MB processing memory (test with a generated fixture); API receives bounded normalised batches only and enforces consent/ownership. Dedupe proven by re-importing. |
| M3 | Analytics engine | Every function in 4.3 has unit tests with fixtures, including edge cases (empty series, single day, gaps, DST change). Daily summaries and baselines recompute on new data. |
| M4 | Alerts | Rules fire on persona (c); copy matches template; every-minute cron dispatch processes persisted escalation deadlines and summary work; fake-clock tests cover acknowledgement, consent, retries, and overlapping invocations; web push registers in Chrome; email goes out via Resend or console stub. |
| M5 | Patient UI | Onboarding, Today, History, More all work on a 390-px wide viewport; Lighthouse PWA installable; no horizontal scroll; golden paths 1–2 pass (see §6 and D009). |
| M6 | Doctor, caregiver, and guardian side | Doctor portal, sharing scopes, consult flow, chat, clinical summary PDF renders correctly for all three personas. Caregiver invite → accept → read-only view → alert forwarding → revoke all work. Guardian-dependent management, guardian consent flag on summaries/PDFs, and conversion at 18 retaining history all work; dependent cannot revoke guardian authority. |
| M7 | Device comparison + legal + pharmacy stubs + deploy | Catalog seeded and verified; legal pages live; export and delete work; app deployed to Vercel preview URL (or `npm run build` passes if deploy is unavailable) and smoke-tested on the deployed URL. |
| M8 | Hardening | Run `/review` on the whole repo; fix every finding that is a real bug; run the full test suite twice; write FINAL_REPORT.md. |
| S1 | Stretch: Fitbit Web API OAuth | Only after M8. Real account connects and syncs 7 days of data. |
| S2 | Stretch: Fitbit / Garmin export importers | Only after S1 or if S1 is blocked by missing credentials. |

---

## 6. Playwright golden paths

Founder-approved sequencing (8 September 2026): keep milestone order and gate each path when its features exist. Paths 1–2 must pass at M5; paths 3–4 and 6–7 join at M6; path 5 joins at M7, when all seven must pass. Continue running previously enabled paths and run the full suite twice at M8. See DECISIONS.md D009.

1. New user → onboarding → load sample persona (b) → sees Today with ≥1 insight → opens History → switches to Temp → sees cycle-phase shading.
2. Persona (c) → sees an "attention" alert on Today → acknowledges it → alert leaves Today and appears in History markers.
3. Patient links a doctor with `summary_only` → generates clinical summary PDF → doctor logs in → sees only summary, not raw History → audit_log row exists.
4. Patient requests `trend_review` consult → doctor accepts → both exchange one message → doctor closes with note → patient sees note.
5. Patient uploads generic CSV with 3 rows → rows appear in History → patient exports data → ZIP contains those rows → patient deletes account → login no longer works and rows are gone.
6. Persona (c) invites a caregiver with `alerts` + `summary_only` scope → caregiver accepts → caregiver sees persona (c)'s Today read-only and cannot open raw History → an attention alert fires → caregiver receives it → patient revokes → caregiver loses access within one page load → audit_log has rows for every caregiver read.
7. Minor self-signup is rejected → adult guardian creates a dependent without a login → grants consent and imports sample data for that dependent → doctor sees "Consent given by guardian" on summary/PDF → another account cannot access the dependent and dependent-originated guardian revocation is rejected → guardian-initiated conversion before 18 is rejected → at 18 (controlled test clock), conversion to a normal account preserves profile/history/consent provenance and retires mandatory guardian access.

---

## 7. Working rules for this run

- Keep a `PROGRESS.md` updated at the end of every milestone: what was built, what was verified (exact commands), what was cut.
- Keep `DECISIONS.md` for any deviation from this plan, with a one-line reason.
- Keep `OPEN_QUESTIONS.md` for anything that needs the founder (legal, pricing, partnerships, product choices you were unsure about).
- If a bug takes more than 20 minutes, stop, isolate it behind a feature flag, record it in OPEN_QUESTIONS.md, and move on.
- Do not install more than one library for the same job. Prefer boring, well-maintained packages.
- No `any` in TypeScript. No skipped tests. No `console.log` left in production paths.
- Never fetch or store real personal data other than what the founder uploads in testing.
- Do not sign up for third-party services, do not accept terms on the founder's behalf, do not spend money. If something needs an account or key, stub it behind an interface and list it in OPEN_QUESTIONS.md.

## 8. Stop condition

Stop when M0–M8 are complete, every verification command in §5 passes, all seven golden paths pass on the deployed (or locally built) app, and FINAL_REPORT.md lists: what works, what was cut, every known limitation, and the exact steps the founder must take next (accounts to create, keys to add, lawyer questions).

If you run out of time before M8, stop at the last fully-verified milestone and make sure `main` is in a passing state. A passing M6 is worth more than a broken M8.
