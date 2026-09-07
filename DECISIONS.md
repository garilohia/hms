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
