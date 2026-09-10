# AGENTS.md

Project: Health Management System (HMS). Full spec in PLAN.md — read it first, every session.

## Commands
- Install: `npm install`
- Dev: `npm run dev`
- Quality gate (run before every commit): `npm run lint && npm run typecheck && npm test`
- E2E: `npm run e2e` (Playwright, headless)
- DB: `npm run db:generate`, `npm run db:migrate`, `npm run db:reset`, `npm run seed`
- Deploy: `npm run build` then `vercel --prod` (skip deploy if not logged in; never prompt for login)

## Conventions
- TypeScript strict. No `any`. No skipped tests. No `console.log` in production paths.
- Pure analytics functions live in `src/lib/analytics/` and never touch the database.
- All device data enters through a `DataSourceAdapter.normalise()` and lands in `metrics` only.
- Every table has RLS. Every doctor read of patient data writes an `audit_log` row.
- Commit at every milestone: `M<n>: <title>`. Keep `main` green.

## Product rules (hard)
- Never write copy that claims to diagnose, detect emergencies, or give medical advice.
- Alert copy uses the exact template in PLAN.md §4.4.
- Insight footers always include "Discuss with your doctor."
- Supplement mentions are phrased "worth asking your doctor about" and never link to a purchase.
- Sample data is always labelled "Sample data" in the UI.
- Three main tabs only: Today, Doctors, History. Everything else under More.
- Short sentences. British/Indian English. No exclamation marks.

## Boundaries
- Do not create third-party accounts, accept terms, or spend money. Stub behind an interface and note in OPEN_QUESTIONS.md.
- Native mobile: the shared versioned server ingestion contract under `app/api/mobile/*` is in scope and built (D026). Compiled HealthKit / Health Connect clients, signing, store review and physical-device acceptance stay out of scope (OQ009).
- Any bug taking more than 20 minutes: flag it, isolate it, log it in OPEN_QUESTIONS.md, move on.
- Ask the founder a question only if the answer would change the architecture. Otherwise decide, record in DECISIONS.md, continue.

## Reporting
- Update PROGRESS.md at the end of every milestone with: built / verified (exact commands) / cut.
- Keep status messages compact: current milestone, what was verified, what remains, blocked or not.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
