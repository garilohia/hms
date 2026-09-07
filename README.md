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

## Database and authentication checks

`npm run db:generate` generates Drizzle migrations; `npm run db:migrate` applies them using the private `DATABASE_URL`. `npm run db:verify` requires a real Postgres connection and verifies migration-from-scratch/RLS in a temporary schema inside a rolled-back transaction. `npm run db:advisors` runs Supabase's advisors. `npm run db:reset` refuses hosted databases: it requires an explicit local `hms_test` database and `HMS_ALLOW_DB_RESET=1`.

`npm run build && npm run auth:verify` exercises real Supabase magic-link token redemption in Chromium, guardian consent, and sign-out. It creates and removes a synthetic test account, and sends no email. The regular browser suite (`npm run e2e`) checks anonymous access and minor signup rejection without sending email. For production sign-in, allow the final app URL and `/auth/callback` in Supabase Auth redirect configuration. A token-hash email template may use `/auth/confirm?token_hash={{ .TokenHash }}&type=email`; both callback forms are implemented.

## Import and sample data

After migrations, `npm run seed` creates all three labelled 90-day sample personas. Repeat runs deduplicate existing readings. These reserved-domain accounts are fixtures, not delivered logins; signed-in users can load the same sample personas from `/more/data` into their own or guardian-owned profile after giving consent.

`/more/data` accepts Apple Health `export.zip` and generic CSV. ZIP/XML stays in a browser Web Worker; only batches of at most 1,000 canonical metrics and 1 MiB reach the server. Keep the tab open. Cancel or retry safely by selecting the same file and source name. Invalid/unsupported records are counted. Apple HRV SDNN is not imported as RMSSD. The CSV template lists timestamp, metric type, value and canonical unit; timestamps must include a UTC offset.

`npm run build && npm run ingestion:verify` checks real CSV persistence and two imports of a generated 210 MiB XML ZIP, including API bounds, deduplication and a 512 MiB renderer-memory ceiling. It needs the supplied Supabase keys/database and Chromium on macOS or Linux (`ps` supplies RSS). Its temporary test account/data are cleaned up. Fixture ZIP and a JSON memory/count report are written under ignored `test-results/`. The sample personas created by `npm run seed` are intentionally retained.
