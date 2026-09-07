# Build progress

## M0 — Repo, tooling, CI

- Built: adopted Next.js 16.3.4/App Router, strict TypeScript, Tailwind and existing Supabase helpers; npm lockfile; public configuration validation; Vitest and Playwright tooling; push/PR GitHub quality workflow; complete tracked environment template; five-line README guide.
- Verified: `npm run check` (`npm run lint && npm run typecheck && npm test`) passed, including 13 configuration tests; `npm run build` passed; `npx playwright install chromium` and `npm run e2e` passed (one real Chromium homepage smoke test).
- Installed: `npx --yes skills add supabase/agent-skills --agent codex --yes` completed, installing Supabase and Postgres best-practice skills.
- Cut: none. Hosted GitHub Actions execution cannot be observed until a Git remote is supplied and the repository is pushed; workflow triggers and local commands are in place. This is tracked as OQ002.
- Remaining: M1–M8 and their full verification. No feature milestone is claimed complete by these bootstrap checks.

## M1 — Schema, auth, RLS, audit

- Built: all 18 planned tables plus immutable-summary storage support; Drizzle migrations; separate profile/account IDs; database-enforced adult signup; guardian-owned dependents and consent provenance; 19 RLS-enabled tables; explicit grants and audited scoped read functions; sign-in, confirmation/callback, account, sign-out, and dependent-creation routes.
- Verified: `npm run check` (23 unit tests); `npm run db:verify` (14 real Postgres migration/RLS tests); `npm run db:migrate` applied the migrations; `npm run db:advisors` reported no issues; `npm run build`; `npm run e2e` (3 Chromium tests); `npm run auth:verify` (real Supabase one-time-link session, dependent consent, and sign-out). Synthetic live Auth account and its data were cleaned up.
- Verification scope: migration-from-scratch tests use isolated temporary schemas and roll back all fixtures. Hosted Actions and inbox delivery remain unobserved, tracked in OQ002–OQ003. Guardian conversion UI and doctor-facing PDFs remain assigned to M6.
- Cut: none. M2 follows below.

## M2 — Ingestion

- Built: deterministic simulator, three-persona CLI seed, bounded CSV and streaming Apple ZIP browser-worker adapters, import/cancel/progress UI, CSV template, aggregator interface/stub, stable source/device deduplication, consent/ownership-checked ingestion and durable affected-day summary jobs.
- Verified: `npm run check` (44 unit tests); `npm run db:verify` (25 real Postgres tests, repeated); `npm run db:migrate`; `npm run seed` twice (22,700 total sample readings, zero new readings on the second pass); `npm run build`; `npm run db:advisors` (no issues); `npm audit --omit=dev` (zero vulnerabilities); `HMS_TEST_PORT=3101 npm run e2e` (5 tests); `HMS_TEST_PORT=3101 npm run auth:verify` (1 live Auth test); `npm run ingestion:verify` (real CSV round-trip and two full browser-worker ZIP imports).
- Large-file evidence: 220,201,254 uncompressed XML bytes; 620,285 records per pass; 6,000 distinct readings added on the first pass and none on the second; 1,243 total batches including CSV; maximum payload 260,111 bytes / 1,000 records; peak renderer RSS 256,753,664 bytes (~245 MiB), sampled 1,562 times. No request, browser or memory-sampling errors in the passing run. The synthetic import actor/data were cleaned up; CLI sample personas remain intentionally. Tracked report: `docs/verification/m2-ingestion.json`.
- Fixed during verification: isolated Playwright output directories to prevent parallel suites deleting the import fixture; reset per-sync counters; bounded request deadlines/backoff and correct retryable service-error status. Early failed runs are not counted as passing evidence.
- Remaining: M3–M8. No M3 implementation started before M2 verification passed.
- Cut: none.

## M3 — Analytics and durable recomputation

- Built: pure baselines, sustained anomalies, local-day summaries, explainable recovery/readiness, anchored cycle estimates and every planned insight rule; persisted score evidence/source provenance; leased, retryable summary processing with seven-day coalescing, historical invalidation and atomic audit/completion; timezone-correct sample generation.
- Verified: `npm run check` (73 tests); `npm run db:verify` (27 real Postgres tests, including historical score changes, stale leases, retries and withdrawn consent); `npm run db:migrate` applied migrations 0004–0005; `npm run seed` twice (zero new rows on both confirmation passes); `npm run summaries:recompute` (270 local-day jobs completed, zero failures); `npm run summaries:verify` (all 270 persisted days, baselines and insights match fresh calculations across 22,700 sample readings); `npm run build`; `HMS_TEST_PORT=3101 npm run e2e` (5); `HMS_TEST_PORT=3101 npm run auth:verify` (1); `npm run db:advisors` (no issues).
- Sample results: 90 days and 13 populated baselines each; persona (b) has the cycle insight, persona (c) has strain/temperature insights; latest readiness scores are 100/100/55. No pending sample summary jobs remain.
- Fixed during verification: qualified an ambiguous SQL sort; reduced per-day database round trips through bounded coalescing; regenerated only the versioned synthetic fixtures after detecting UTC samples spilling into a 91st local day. Their data are reproducible via the seed; uploaded data were not removed.
- Cut: none. Every-minute dispatch remains M4; M3 verifies the durable processor through its CLI. M4 has not started before these gates passed.
