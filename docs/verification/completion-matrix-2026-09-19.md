# Completion verification — 19 September 2026

## Scope and release identity

This is the follow-through for requested engineering items 3–8: Realtime and its regression, deployed migrations, the verification matrix, current handoff documentation and hosted smoke checks. The deployed application remains `16652ad489d0e29e608090ba6259de2d5b23c87c`; the starting documentation revision was `71dc2ad`. This pass changes test coverage, documentation and shared chart presentation: native radios use the interaction token, compact charts retain required axes, Advanced overlays use the shared baseline boundary language, and alert-notch hit targets meet the accessibility floor. It does not change data models, routes, clinical rules, metric values or deployment settings.

Realtime, migration and release evidence is in [the shared-budget report](provider-budget-2026-09-19.md). Both databases have 43 migrations through 0042. The hosted public suite passes; full signed-in hosted acceptance remains **not green** under OQ016. No further Production retry was made to obscure that failure.

## Fresh local checks

All browser commands below use a local production server on port 3112 and synthetic Supabase fixtures. They are not isolated Preview or real-device acceptance. Auth explicitly blanked `RESEND_API_KEY` and `VAPID_PRIVATE_KEY`. Alert/import commands also blanked `GOOGLE_HEALTH_CLIENT_ID`, `GOOGLE_HEALTH_CLIENT_SECRET`, `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET`. Auth additionally supplied an unused `HMS_PROVIDER_SYNC_ENABLED=false`; it is not an implemented safety switch and is not relied upon. Before the alert/import sequence, read-only Production counts were zero pending deliveries, zero provider connections and zero pending summaries.

| Command (outbound-empty prefix omitted) | Result |
|---|---|
| `HMS_TEST_PORT=3112 npm run auth:verify -- --workers=1 --max-failures=1 --output test-results/completion-auth-2026-09-19` | Two tests pass in 9.5 seconds: generated magic-link redemption, guardian consent, sign-out and bearer source/immutable batch retry. No real email is sent. |
| `HMS_TEST_PORT=3112 npm run alerts:verify -- --workers=1 --max-failures=1 --output test-results/completion-alerts-2026-09-19` | One test passes in 17.6 seconds: protected tick, synthetic alert evaluation, stubbed delivery, local Chromium notification and acknowledgement. |
| `HMS_TEST_PORT=3112 caffeinate -i npm run ingestion:verify -- --max-failures=1 --output test-results/completion-ingestion-2026-09-19` | Both tests pass in 2.3 minutes, including Apple ZIP and Google Health/Fit folder import/re-import. |
| `npm run pdf:verify` with the Poppler settings below | Six one-page fixtures pass. All six PNGs were visually inspected: three personas, guardian long-text, Hindi/Latin and wide-glyph stress. No overlap, clipping of required content or missing glyphs observed; explicit long-name/title truncation and omitted-entry counts remain labelled. |
| `npm run check` | Lint, strict TypeScript, both-mode contrast and 366 unit tests pass. |
| `npm run build` | All 55 routes build. |
| `npm run db:verify` | All 115 database tests pass in 153.22 seconds. |
| `HMS_TEST_PORT=3113 npm run e2e -- --max-failures=1 --output test-results/completion-public-2026-09-19` | Nine public/boundary browser tests pass in 2.8 seconds. No signed-in or physical-device claim. |
| `HMS_TEST_PORT=3112 caffeinate -i npm run golden:verify -- --max-failures=1 --output test-results/completion-golden-2026-09-19` with the PDF text/font settings above | All eleven tests pass together in 4.3 minutes on the current application, including all seven golden paths and no-refresh Today/History/chat. No deadline or substantive assertion changed. |
| `npm audit --omit=dev` | Zero reported production dependency vulnerabilities. Not a penetration test. |
| `npm run db:advisors` | Exits successfully but reports the known `pg_net` warning. Success is not a clean security assessment. |

PDF environment used:

```sh
HMS_PDFINFO=/Users/gari/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdfinfo
HMS_PDFTOTEXT=/Users/gari/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdftotext
HMS_PDFTOPPM=/Users/gari/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdftoppm
FONTCONFIG_FILE=/Users/gari/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/etc/fonts/fonts.conf
```

These are command environment assignments, not credentials or files to commit. Fixture output stays under ignored `test-results/`.

### Import measurements

The Apple fixture contains 220,201,254 uncompressed XML bytes, 620,285 records and 6,000 distinct readings. First pass: 61,629 ms, 6,000 inserted and 614,285 skipped. Re-import: 62,663 ms, zero inserted and 620,285 skipped. The test observed three workers, 1,243 batches, at most 1,000 records/260,111 bytes per batch and 324,255,744 bytes peak total Chromium renderer RSS (below 512 MiB), with 617 memory samples and no browser/memory errors. This is one synthetic local-server/WAN run, not a speed promise for arbitrary exports, devices or deployed functions. Google Health/Fit folder assertions additionally verify supported metrics, two skipped unrelated/redundant files and zero inserts on re-import.

The complete import report is retained locally at `test-results/completion-ingestion-2026-09-19/import-CSV-round-trip-and--6cfd6-ry-and-idempotent-re-import-chromium/ingestion-report.json`. Historical slower benchmarks remain unchanged in earlier reports.

## Security and test-isolation limits

- Current read-only table inventory: all 24 public tables have RLS. Of four private tables, integration connections and provider request budgets have forced RLS. Native batch receipts and push subscriptions lack RLS but deny SELECT to `anon` and `authenticated`; do not claim RLS on every private table.
- The connected Production security advisor reports the same two OQ017 warnings and seven informational no-policy notices. See [managed extension guidance](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public) and [password protection guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). No extension/grant workaround or paid plan was attempted.
- Existing live tests can invoke global dispatch, including through the immediate ingestion path. Empty outbound credentials prevent external sends, but stubbing can still consume unrelated pending deliveries. A momentary empty-queue preflight is not isolation. Do not run these suites against an environment receiving real patient work; complete the separate synthetic Preview first (OQ011).
- Some older live-test/shared-fixture cleanup blocks stop after an initial cleanup error. No cleanup error occurred in this pass, but robust cleanup and isolated test dispatch remain test-harness limitations, not proof of production safety. The design-audit cleanup is hardened separately in this pass.

## Expanded visual audit

After a fresh `npm run build`, the outbound-empty `HMS_TEST_PORT=3112 caffeinate -i npm run design:audit` passed in 10.0 minutes. It produced 87 complete 390px screenshots in both colour schemes, plus the three required 200% text captures. All 25 required route/state families returned HTTP 200 on their intended path; no page errors or horizontal overflow were recorded. The harness owns and removes its exact synthetic practitioner, patients, caregiver, onboarding accounts and consultations. It requires the consultation, verified-doctor queue, doctor summary and doctor consultation captures instead of silently omitting them. The tracked manifest records `state: complete`, 87 shots, zero page errors, zero notes and zero failures.

The selected Display radio originally exposed native browser blue outside the locked palette; the final light/dark capture shows `--accent`. Two new `history-advanced-overlays-*` captures require rendered overlay segments, three end labels and both overlay names in the chart text alternative. Manual review confirms Summary and Simple charts now show the top unit and both endpoint dates. The §13 route walk is in `DESIGN_AUDIT.md`.

After the chart correction, the full outbound-empty `HMS_TEST_PORT=3112 caffeinate -i npm run golden:verify -- --max-failures=1 --output test-results/completion-followthrough-golden-2026-09-22` passed all eleven tests in 8.8 minutes. This re-proves all seven golden paths and the no-refresh Today/History/chat regression on the final local application; it is not hosted acceptance.

## Remaining evidence

Existing latest-release hosted public evidence remains in the linked release report; it is not represented as a new full hosted pass here. Preview owner access/credentials, real provider consent/approval, sender/domain and physical-device delivery, security review and legal/clinical approval remain external gates. No third-party provider account, terms acceptance, purchase or real message was created by this pass.
