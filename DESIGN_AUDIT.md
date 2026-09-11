# DESIGN_AUDIT.md — DESIGN.md §13 walk, 11 September 2026

Updated the same day after the founder's decisions (D030, D031): Apple-like rounding, the floating tab bar, the three densities, the copy rewrite and the 200% text check. The route list below reflects the final capture.

Source: `design-audit/*.png`, 73 full-page screenshots of every route at 390px wide in light and dark mode, plus `design-audit/manifest.json`. Captured by `HMS_TEST_PORT=3101 npm run design:audit` against the production build with synthetic accounts that were removed afterwards. Every screenshot reports a document width of 390px, so no route scrolls horizontally, and no page error was logged.

The ten §13 questions were asked of each screenshot. Items that pass on every route are summarised once; the route list below records only what fails or could not be verified from a screenshot.

## Verified on every route

- **§13.1, 390px.** Passes everywhere; the audit fails the run if any route exceeds 390px. Reduced motion disables the chart draw and every transition through one global rule. Keyboard focus is a 2px `--accent` outline on every interactive element.
- **§13.2, legible without colour.** Alert state pairs the rule colour with an icon and a word. The active tab pairs sage with a heavier weight. Pressed chips pair sage with weight. Cycle phases are hatch patterns with a labelled swatch. Notches carry "acknowledged" in their accessible name.
- **§13.3, tabular numerals.** `font-variant-numeric: tabular-nums` is set on the root and inherited by every number, including the serif hero figures and chart labels.
- **§13.4, sage and champagne roles.** No champagne appears on anything tappable. Sage appears on buttons, links, the active tab, pressed chips and focus rings, plus the freshness dot that §7.5 mandates.
- **§13.5 and §13.6, chart language.** The line changes ink at the band boundary and the last value is labelled on every line chart. The dashed band and "N of 28 days" count are unit-tested; the sample personas carry 90 days, so no screenshot shows the building state.
- **§13.7, template copy.** Alert bodies use the PLAN.md §4.4 template. Insight footers end with "Discuss with your doctor." No copy was changed by this pass.
- **§13.8, primary number.** Hero figures are Source Serif 4 at 3.25rem (55px) in every mode.

## Verified in the final capture

- **§13.1, 200% text.** Today, History and More were captured with the root font at 34px (`*-200pct-light.png`); each stays at 390px wide with no horizontal scroll. Buttons and cards wrap; the chart keeps its width and the tab bar island stays within the viewport.
- **§9, densities.** `today-simple`, `history-simple`, `today-advanced` and `history-advanced` show the same palette, type, navigation and alert treatment at each density.

## Not verified by this audit

- **§13.6, live building state.** Only covered by unit tests; needs a persona with fewer than 28 days.

## Findings by route

### Today (`today`, `today-readiness`, `caregiver-today`)
- **§13.4 (sage on a non-tappable element).** One sage dot that is not tappable: the freshness dot required by §7.5. The former "Live updates connected" line was removed (D031); only an interrupted connection is still announced.
- **§13.9 (doctor reads it unaided).** Passes. The caregiver view (`caregiver-today`) has no chart because summary-only scope cannot read daily rows; it shows the single-value hero and "Read-only shared view".

### History (`history`, `history-7days`, `history-sleep`, `history-temp`)
- **§12 (middle-dot meta strings).** Rewritten: the "Unusual readings" chips now read "2026-09-08: 2 readings, acknowledged" and the reading detail uses a comma. Passes.
- **§13.6.** Sleep and Steps bars start from zero; the band is drawn behind them. The seven-day range keeps the band from the earlier rows. Passes.
- **Cycle shading (`history-temp`).** Hatching sits at 30% opacity so the line and band read first; the founder approved the treatment (OQ013).

### Doctors, Consult (`doctors`, `consult`)
- **§12.** Consult header now reads "Sample persona c with Sample doctor" and the status line uses a comma. Passes.
- Otherwise passes. Secondary buttons show the sage word on a hairline, primary actions use the sage fill.

### More and children (`more`, `more-data`, `more-devices`, `more-alerts`, `more-cycle`, `more-pharmacy`, `more-family`, `more-advanced`, `more-advanced-latency`)
- **§13.10 (`more-alerts`).** The threshold editor now sits behind a collapsed "Thresholds" disclosure with the recommended defaults stated; the page is about a third of its former length.
- **§12.** Meta strings on latency, family and data screens are rewritten as sentences or comma lists. Passes.
- **`more-devices`.** The comparison table is wider than 390px inside its own scroll container, which DESIGN.md allows. The table header uses `--ink-soft` at 600 weight. Passes.
- **`more-advanced`.** Baselines are shown numerically in list rows for every density; Advanced History additionally shows the usual range and formula next to the chart.

### Doctor portal (`doctor`, `caregiver-alerts`)
- Passes. Registration form and empty patient list use the card and secondary button. Shared alerts use plain cards with the severity word; they are a list, not an alert surface, so they carry no top rule. If the founder wants the §6 treatment on the doctor's alert list as well, it is a one-line class change.

### Account, delete (`account`, `account-delete`)
- Passes. The destructive "Permanently delete account" button is sage, as §4.4 forbids `--urgent` on any button. The confirmation field and checkbox carry the weight instead.

### Summary (`summary`)
- **§5.5 (axis labels).** Sparklines omit the top unit label and the end dates to stay compact; the card title carries the unit and the date range is stated once above the cards. Recorded as a deliberate compact variant; the full chart in History has both.
- Passes otherwise: band, boundary split, end label.

### Onboarding (`onboarding-1` to `onboarding-4`), Home (`home`), Sign in (`sign-in`), Legal (`legal-privacy`, `legal-terms`, `legal-disclaimer`)
- Passes. No tab bar, serif titles, sage primary button, hairline inputs at 10px radius (D030). Legal pages stay under 70 characters per line.

## Items settled with the founder on 11 September 2026

1. Hatching is the cycle-phase treatment (OQ013 resolved).
2. The reference HTML's dark urgent red fails the contrast floor on `--surface-2`, so DESIGN.md's `#F4655E` stays (OQ014).
3. The three densities now exist (D031).
4. Middle-dot meta strings are rewritten (D031).
5. The "Live updates connected" line is gone (D031).
6. Apple-like rounding and the floating tab bar are in (D030).

## Still open

- Summary sparklines omit axis labels by design; History carries the full chart.
- Resolved 11 September 2026: the doctor's shared alert list now uses the §6 rule and label, matching Today.
