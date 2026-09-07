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
- Cut: none. M2 has not started.
