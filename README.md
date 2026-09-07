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
