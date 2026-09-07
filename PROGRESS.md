# Build progress

## M0 — Repo, tooling, CI

- Built: adopted Next.js 16.3.4/App Router, strict TypeScript, Tailwind and existing Supabase helpers; npm lockfile; public configuration validation; Vitest and Playwright tooling; push/PR GitHub quality workflow; complete tracked environment template; five-line README guide.
- Verified: `npm run check` (`npm run lint && npm run typecheck && npm test`) passed, including 13 configuration tests; `npm run build` passed; `npx playwright install chromium` and `npm run e2e` passed (one real Chromium homepage smoke test).
- Installed: `npx --yes skills add supabase/agent-skills --agent codex --yes` completed, installing Supabase and Postgres best-practice skills.
- Cut: none. Hosted GitHub Actions execution cannot be observed until a Git remote is supplied and the repository is pushed; workflow triggers and local commands are in place. This is tracked as OQ002.
- Remaining: M1–M8 and their full verification. No feature milestone is claimed complete by these bootstrap checks.
