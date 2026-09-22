# DESIGN_AUDIT.md — DESIGN.md §13 walk, updated 22 September 2026

Updated after the founder's decisions (D030, D031) and the completion follow-through (D045, D046): Apple-like rounding, the floating tab bar, three densities, compact-chart axes, Advanced overlay states, exact owned doctor fixtures, the copy rewrite and the 200% text check. The route list below reflects the final capture.

Source: `design-audit/*.png`, 87 full-page screenshots of every required route/state at 390px wide in light and dark mode, plus `design-audit/manifest.json`. Captured after `npm run build` by an outbound-empty `HMS_TEST_PORT=3112 caffeinate -i npm run design:audit` against the production build. The manifest is `complete`, with zero page errors, notes, failures or cleanup errors. Every screenshot reports a document width of 390px, so no route scrolls horizontally. The fixture owned and removed its exact patients, caregiver, practitioner, onboarding actors, consultation and associated synthetic data.

The ten §13 questions were asked of each screenshot. Items that pass on every route are summarised once; the route list below records only what fails or could not be verified from a screenshot.

## Verified on every route

- **§13.1, 390px.** Passes everywhere; the audit fails the run if any route exceeds 390px. Reduced motion disables the chart draw and every transition through one global rule. Keyboard focus is a 2px `--accent` outline on every interactive element.
- **§13.2, legible without colour.** Alert state pairs the rule colour with an icon and a word. The active tab pairs sage with a heavier weight. Pressed chips pair sage with weight. Cycle phases are hatch patterns with a labelled swatch. Notches carry "acknowledged" in their accessible name.
- **§13.3, tabular numerals.** `font-variant-numeric: tabular-nums` is set on the root and inherited by every number, including the serif hero figures and chart labels.
- **§13.4, sage and champagne roles.** No champagne appears on anything tappable. Sage appears on buttons, links, the active tab, pressed chips and focus rings, plus the freshness dot that §7.5 mandates.
- **§13.5 and §13.6, chart language.** The line changes ink at the band boundary and the last value is labelled on every line chart. Summary and Simple compact charts retain the top unit label and both endpoint dates. Advanced overlays use their own baselines, boundary splits and end labels, with dash/weight distinctions and a combined text alternative. The dashed band and "N of 28 days" count are unit-tested; the sample personas carry 90 days, so no screenshot shows the building state.
- **§13.7, template copy.** Alert bodies use the PLAN.md §4.4 template. Insight footers end with "Discuss with your doctor." No copy was changed by this pass.
- **§13.8, primary number.** Hero figures are Source Serif 4 at 3.25rem (55px) in every mode.

## Verified in the final capture

- **§13.1, 200% text.** Today, History and More were captured with the root font at 34px (`*-200pct-light.png`); each stays at 390px wide with no horizontal scroll. Buttons and cards wrap; the chart keeps its width and the tab bar island stays within the viewport.
- **§9, densities.** `today-simple`, `history-simple`, `today-advanced` and `history-advanced` show the same palette, type, navigation and alert treatment at each density.
- **§9, Advanced overlays.** `history-advanced-overlays` shows two overlays in both schemes. The test requires rendered overlay paths, three end-value labels and both overlay metric names in the chart's `aria-label`.
- **§12, native controls.** `more-display` shows the selected radio in `--accent`; the browser's former native blue is no longer present.

## Not verified by this audit

- **§13.6, live building state.** Only covered by unit tests; needs a persona with fewer than 28 days.

## Findings by route

### Today (`today`, `today-readiness`, `caregiver-today`)
- **§13.4 (sage on a non-tappable element).** One sage dot that is not tappable: the freshness dot required by §7.5. The former "Live updates connected" line was removed (D031); only an interrupted connection is still announced.
- **§13.9 (doctor reads it unaided).** Passes. The caregiver view (`caregiver-today`) has no chart because summary-only scope cannot read daily rows; it shows the single-value hero and "Read-only shared view".

### History (`history`, `history-7days`, `history-sleep`, `history-temp`, `history-simple`, `history-advanced`, `history-advanced-overlays`)
- **§12 (middle-dot meta strings).** Rewritten: the "Unusual readings" chips now read "2026-09-08: 2 readings, acknowledged" and the reading detail uses a comma. Passes.
- **§13.6.** Sleep and Steps bars start from zero; the band is drawn behind them. The seven-day range keeps the band from the earlier rows. Passes.
- **Cycle shading (`history-temp`).** Hatching sits at 30% opacity so the line and band read first; the founder approved the treatment (OQ013).
- **Compact and overlay states.** Simple compact charts retain the required top unit and endpoint dates. Advanced overlays keep the primary chart's token roles and boundary language; one label is rendered per series. Passes.

### Doctors, Consult (`doctors`, `consult`)
- **§12.** Consult header now reads "Sample persona c with Sample doctor" and the status line uses a comma. Passes.
- Otherwise passes. Secondary buttons show the sage word on a hairline, primary actions use the sage fill.

### More and children (`more`, `more-data`, `more-devices`, `more-alerts`, `more-cycle`, `more-pharmacy`, `more-family`, `more-display`, `more-advanced`, `more-advanced-latency`)
- **§13.10 (`more-alerts`).** The threshold editor now sits behind a collapsed "Thresholds" disclosure with the recommended defaults stated; the page is about a third of its former length.
- **§12.** Meta strings on latency, family and data screens are rewritten as sentences or comma lists. Passes.
- **`more-devices`.** The comparison table is wider than 390px inside its own scroll container, which DESIGN.md allows. The table header uses `--ink-soft` at 600 weight. Passes.
- **`more-advanced`.** Baselines are shown numerically in list rows for every density; Advanced History additionally shows the usual range and formula next to the chart.
- **`more-display`.** Selected radios use `--accent`, not the user agent's blue. Passes in both schemes.

### Doctor portal and shared care (`doctor`, `doctor-verified`, `doctor-summary`, `doctor-consult`, `caregiver-alerts`, `caregiver-family`, `caregiver-today`)
- Passes. The verified-doctor capture requires the owned synthetic patient and requested consultation; the doctor summary and consultation must open on their intended route. Shared alert cards use the §6 rule and label. Caregiver views remain read-only and state whose data is shown.

### Account, delete (`account`, `account-delete`)
- Passes. The destructive "Permanently delete account" button is sage, as §4.4 forbids `--urgent` on any button. The confirmation field and checkbox carry the weight instead.

### Summary (`summary`)
- Passes: compact charts retain the top unit label, both endpoint dates, baseline band, boundary split, end label and text alternative.

### Onboarding (`onboarding-1` to `onboarding-4`), Home (`home`), Sign in (`sign-in`), Legal (`legal-privacy`, `legal-terms`, `legal-disclaimer`)
- Passes. No tab bar, serif titles, sage primary button, hairline inputs at 10px radius (D030). Legal pages stay under 70 characters per line.

## Items settled with the founder on 11 September 2026

1. Hatching is the cycle-phase treatment (OQ013 resolved).
2. Superseded 14 September 2026: the founder chose the reference HTML's `#F0554F` (D034). Urgent only ever renders on `--surface`, where it clears 4.5:1, and the build now fails if it is ever placed on `--surface-2`.
3. The three densities now exist (D031).
4. Middle-dot meta strings are rewritten (D031).
5. The "Live updates connected" line is gone (D031).
6. Apple-like rounding and the floating tab bar are in (D030).

## Still open

- No captured route has a known DESIGN.md §13 failure.
- The live under-28-day baseline state is verified by chart unit tests rather than a screenshot fixture; the dashed outline and count remain the only audit item not demonstrated visually.
