# DESIGN_AUDIT.md — DESIGN.md §13 walk, 11 September 2026

Source: `design-audit/*.png`, 66 full-page screenshots of every route at 390px wide in light and dark mode, plus `design-audit/manifest.json`. Captured by `HMS_TEST_PORT=3101 npm run design:audit` against the production build with synthetic accounts that were removed afterwards. Every screenshot reports a document width of 390px, so no route scrolls horizontally, and no page error was logged.

The ten §13 questions were asked of each screenshot. Items that pass on every route are summarised once; the route list below records only what fails or could not be verified from a screenshot.

## Verified on every route

- **§13.1, 390px.** Passes everywhere; the audit fails the run if any route exceeds 390px. Reduced motion disables the chart draw and every transition through one global rule. Keyboard focus is a 2px `--accent` outline on every interactive element.
- **§13.2, legible without colour.** Alert state pairs the rule colour with an icon and a word. The active tab pairs sage with a heavier weight. Pressed chips pair sage with weight. Cycle phases are hatch patterns with a labelled swatch. Notches carry "acknowledged" in their accessible name.
- **§13.3, tabular numerals.** `font-variant-numeric: tabular-nums` is set on the root and inherited by every number, including the serif hero figures and chart labels.
- **§13.4, sage and champagne roles.** No champagne appears on anything tappable. Sage appears on buttons, links, the active tab, pressed chips and focus rings, plus the two mandated status dots noted below.
- **§13.5 and §13.6, chart language.** The line changes ink at the band boundary and the last value is labelled on every line chart. The dashed band and "N of 28 days" count are unit-tested; the sample personas carry 90 days, so no screenshot shows the building state.
- **§13.7, template copy.** Alert bodies use the PLAN.md §4.4 template. Insight footers end with "Discuss with your doctor." No copy was changed by this pass.
- **§13.8, primary number.** Hero figures are Source Serif 4 at 3.25rem (55px) in every mode.

## Not verified by this audit

- **§13.1, 200% text.** Not measured. The layout uses rem units and a 70ch line length, but no screenshot was taken at 200% zoom. Recommended as a follow-up run.
- **§13.6, live building state.** Only covered by unit tests; needs a persona with fewer than 28 days.

## Findings by route

### Today (`today`, `today-readiness`, `caregiver-today`)
- **§13.4 (sage on a non-tappable element).** Two sage dots that are not tappable: the freshness dot required by §7.5, and the pre-existing "Live updates connected" status dot which now uses the same treatment. DESIGN.md mandates the first; the second is a candidate for removal under §13.10 because the freshness line already answers the question. Left in place because it is existing behaviour and copy.
- **§13.10 (remove one element).** The "Live updates connected" line and the freshness line sit six pixels apart and say similar things. See above.
- **§13.9 (doctor reads it unaided).** Passes. The caregiver view (`caregiver-today`) has no chart because summary-only scope cannot read daily rows; it shows the single-value hero and "Read-only shared view".

### History (`history`, `history-7days`, `history-sleep`, `history-temp`)
- **§12 (middle-dot meta strings).** The "Unusual readings" chips read "2026-09-08 · 2 · acknowledged" and the reading detail reads "… · Diastolic …". Copy is out of scope for this pass; flagged for a copy change to "2 readings, acknowledged" style.
- **§13.6.** Sleep and Steps bars start from zero; the band is drawn behind them. The seven-day range keeps the band from the earlier rows. Passes.
- **Cycle shading (`history-temp`).** Hatching now sits at 30% opacity so the line and band read first. Whether hatching is acceptable at all is OQ013.

### Doctors, Consult (`doctors`, `consult`)
- **§12 (middle-dot meta strings).** Consult header "Sample persona c · Sample doctor · verified" and status line "trend review · requested". Copy-level, flagged.
- Otherwise passes. Secondary buttons show the sage word on a hairline, primary actions use the sage fill.

### More and children (`more`, `more-data`, `more-devices`, `more-alerts`, `more-cycle`, `more-pharmacy`, `more-family`, `more-advanced`, `more-advanced-latency`)
- **§13.10 (`more-alerts`).** The page stacks monitor rules, acknowledged alerts, thresholds, contact and push sections into one very long scroll (about 24,000px full-page). It passes the system but would benefit from collapsing the rule editor behind the recommended defaults. Behaviour change, not attempted.
- **§12 (`more-advanced-latency`, `more-family`, `more-data`).** Several "a · b" meta strings in secondary text. Copy-level, flagged.
- **`more-devices`.** The comparison table is wider than 390px inside its own scroll container, which DESIGN.md allows. The table header uses `--ink-soft` at 600 weight. Passes.
- **`more-advanced`.** Baselines are shown numerically in list rows; DESIGN.md §9 places this under Advanced density, which does not exist as a mode (OQ014). Passes visually.

### Doctor portal (`doctor`, `caregiver-alerts`)
- Passes. Registration form and empty patient list use the card and secondary button. Shared alerts use plain cards with the severity word; they are a list, not an alert surface, so they carry no top rule. If the founder wants the §6 treatment on the doctor's alert list as well, it is a one-line class change.

### Account, delete (`account`, `account-delete`)
- Passes. The destructive "Permanently delete account" button is sage, as §4.4 forbids `--urgent` on any button. The confirmation field and checkbox carry the weight instead.

### Summary (`summary`)
- **§5.5 (axis labels).** Sparklines omit the top unit label and the end dates to stay compact; the card title carries the unit and the date range is stated once above the cards. Recorded as a deliberate compact variant; the full chart in History has both.
- Passes otherwise: band, boundary split, end label.

### Onboarding (`onboarding-1` to `onboarding-4`), Home (`home`), Sign in (`sign-in`), Legal (`legal-privacy`, `legal-terms`, `legal-disclaimer`)
- Passes. No tab bar, serif titles, sage primary button, hairline inputs at 4px radius. Legal pages stay under 70 characters per line.

## Items to raise with the founder

1. Whether hatching is an acceptable cycle-phase treatment (OQ013).
2. The dark `--urgent` mismatch between the reference HTML and DESIGN.md (OQ014); `#F4655E` shipped.
3. The three densities do not exist in code (OQ014).
4. Middle-dot meta strings in existing copy across History, Consult, More and Latency (§12), which this visual-only pass did not rewrite.
5. Whether the "Live updates connected" line should go now that the freshness line exists (§13.10).
