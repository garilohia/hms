# DESIGN.md — HMS design system (locked)

Repository copy, 11 September 2026. Founder decisions recorded in DECISIONS.md D028–D031 are folded in below; the earlier Downloads copy is superseded.

Read this before writing or changing any UI. It overrides any installed design skill wherever the two disagree. Every hex value in §4 was contrast-checked; do not substitute.

---

## 1. What this product is

A perpetual personal health record. Its users are an anxious 34-year-old in Dubai checking their father's SpO2 at 2am, a 65-year-old in Kolkata reading it on a phone in bright sun, and a 40-year-old who lifts heavy and wants their HRV trend. Half of them will show a screen from this app to a doctor.

The rolling range is the 28-day median ± 3 MAD (D028).

The design's job, in order: be trusted, be read correctly under stress, be beautiful. Never invert that order.

## 2. The one non-negotiable

**There is one design system and three densities. There are not three designs.**

Simple, Standard and Advanced share the same palette, type, spacing, chart language, navigation and copy. They differ only in how much is shown and how deep it goes. A user moving between them must recognise the same product.

## 3. Where the boldness goes

Spend it entirely on the **chart and timeline language**. Everything else stays quiet.

The chrome is warm charcoal on a gradient, the type is a serif numeral over a sans body, and there is one green for things you tap, one champagne for the data line, and one red for danger. That is the whole identity. Do not add a colour.

## 4. Tokens

### 4.1 Ground

The page ground is a vertical gradient, lighter at the top and deeper at the bottom. Cards float on it. This is the only gradient in the product.

```
dark   linear-gradient(180deg, #17130F 0%, #100D0A 100%)
light  linear-gradient(180deg, #FAF9F6 0%, #F4F2ED 100%)
```

Never use a flat ground colour. Never add a second gradient anywhere.

### 4.2 Colour tokens

```
                     dark        light
--surface            #221D18     #FFFFFF     cards, sheets, tab bar
--surface-2          #2D2620     #F3F0EA     nested panels inside a card (Advanced needs this)
--rule               #342D26     #E9E4DC     hairlines, gridlines, card borders
--rule-lit           #443B32     #E9E4DC     card top border only (see §7.4)
--ink                #F0EAE2     #201B14     body text, numerals, headings
--ink-soft           #A79C90     #6B6156     units, axis labels, secondary text, attention state
--band               #2B241C     #F0ECE4     the 28-day baseline band; the only fill in the product
--accent             #57B394     #1E6B55     INTERACTION ONLY: buttons, links, active tab, focus ring
--on-accent          #0D1A15     #FFFFFF     text on a filled accent button
--data               #D4C4A0     #8A7A52     DATA ONLY: the chart line and bars while inside the band
--urgent             #F0554F     #C8262C     STATE ONLY: the urgent alert label and rule.
                                                 Never on --surface-2 (see §4.5).
```

### 4.3 The two-role accent rule

`--accent` (sage) and `--data` (champagne) are not interchangeable and never appear in each other's role.

- Sage is for things you can tap. Buttons, links, the active tab, focus rings. Nothing else.
- Champagne is for data. The chart line, chart bars, sparklines. Nothing else. It is never used on a button, a link, an icon or text.

Reason: a 65-year-old needs a button to look like a button. Sage against warm charcoal is unmistakably interactive. Champagne is not, and it doesn't need to be, because a chart line isn't tappable.

### 4.4 State colours

There is exactly one warning colour, `--urgent`. It appears in exactly two places: the 2px rule at the top of an urgent card, and the urgent card's label text. It never fills a card, never borders a whole card, never appears on a button, and never appears anywhere that isn't an urgent alert.

The attention state has no hue. It uses `--ink-soft` for its rule and icon, and `--ink` for its label. See §6.

### 4.5 Verified contrast

Every text pair below was computed against WCAG 2.1. Do not change a token without re-running the check.

```
                          dark      light     requirement
ink on surface            13.98     17.10     4.5
ink on gradient (worst)   15.46     15.28     4.5
ink on surface-2          12.47     15.03     4.5
ink-soft on surface        6.21      6.05     4.5
ink-soft on gradient       6.86      5.41     4.5
ink-soft on surface-2      5.53      5.32     4.5
ink-soft on band           5.69      5.14     4.5
accent on surface          6.59      6.38     4.5
on-accent on accent        7.04      6.38     4.5
urgent on surface          4.87      5.57     4.5
data on band (graphic)     8.90      3.57     3.0
data on surface (graphic)  9.71      4.21     3.0
```

`--rule` does not meet 3:1 against `--surface` in either mode. That is correct. Hairlines are decorative separators, not information-bearing objects, and are exempt. Do not thicken or darken them to "fix" this.

### 4.6 Type

```
UI, body, labels    IBM Plex Sans
Numerals, display   Source Serif 4
```

Every number uses `font-variant-numeric: tabular-nums`. Digits must not shift width as values change.

Scale, in rem, on a 17px root:

```
hero      3.25   Source Serif 4, 400,  -0.02em
title     1.50   Source Serif 4, 500
section   1.125  IBM Plex Sans, 600
body      1.00   IBM Plex Sans, 400,  1.55 line-height
label     0.875  IBM Plex Sans, 500
axis      0.75   IBM Plex Sans, 400
```

Body never goes below 17px in any mode. Simple mode raises it to 19px. Line length under 70 characters. Sentence case everywhere. No all-caps labels.

### 4.7 Spacing, radius, elevation

4px base unit. Card padding 20px. Section gap 32px.

Radius is hierarchical and Apple-like (D030): 10px on inputs and chips, 14px on buttons, 20px on cards, 28px on sheets, modals and the tab bar. Every rounded surface declares `corner-shape: squircle` so browsers that support continuous corners draw them.

Elevation is carried by the gradient ground, the surface step, and the lit top edge (§7.4). There are no drop shadows anywhere except the bottom sheet, which gets one. The tab bar floats as an inset island 12px above the safe area, separated by its hairline and lit top edge, never a shadow (D030).

## 5. Chart language

Identical in all three modes; only the number of series and controls changes.

### 5.1 The band
The user's rolling 28-day range renders as a `--band` fill behind the data. Nothing else in the product gets a fill. Cycle phases on the temperature chart are hairline hatch patterns in `--ink-soft`, not fills, with a swatch and the phase word in the legend (D031).

### 5.2 The line changes ink when it leaves the band (required)
- Inside the band: `--data`, 1.5px.
- Outside the band: `--ink`, 2px, with a 2.2px dot on the last point.

"Unusual for you" is visible on the chart itself with no warning colour spent. Split the polyline at the band boundary; do not recolour the whole series.

### 5.3 The last value is labelled (required)
One number in Source Serif 4 at `axis` size, in `--ink`, placed immediately after the last point. Never more than one label per series.

### 5.4 The honest baseline state (required)
With fewer than 28 days of data, the band draws as a dashed `--rule` outline with no fill, and the card carries one line: "Building your baseline" on the left, "N of 28 days" in `--ink` on the right. Never fake a baseline from insufficient data.

### 5.5 Everything else
- Gridlines: hairline `--rule`, horizontal only, at most four.
- No chart border, no legend box, no background tint on the plot area.
- Y axis labelled once at the top with its unit. X axis labelled at the ends only, with real dates.
- Alert markers are 2px notches on the axis in `--urgent`, never pins over the data.
- Missing data breaks the line. Never interpolate across a gap.
- Bars are square-capped, `--data`, 85% opacity except the most recent at 100%.
- Every chart carries a text alternative: one sentence stating metric, range, direction and whether it sits inside the baseline.

## 6. Alert treatment

Two states, one visual pattern. No tinted washes, no full coloured borders, ever.

Both states render as a normal `--surface` card with one addition: a 2px rule across the top inside the card padding, and a bold 12px label with an icon.

```
             top rule      icon         label text
attention    --ink-soft    --ink-soft   --ink
urgent       --urgent      --urgent     --urgent
```

Alert copy uses the template in PLAN.md §4.4 verbatim. Every insight and alert ends with the discuss-with-your-doctor line.

## 7. The five elevation moves (all required)

1. **The line changes ink when it leaves the band.** §5.2.
2. **The last value is labelled.** §5.3.
3. **Honest baseline-building state.** §5.4.
4. **Lit-edge cards, dark mode only.** Every card's top border is `--rule-lit`; the other three sides are `--rule`. In light mode all four sides are `--rule`. The floating tab bar shares the lit edge because it needs separation from content passing beneath it (D030); sheets do not.
5. **Freshness line under the header.** Below the date on Today: a 5px `--accent` dot and "Synced N minutes ago" in `--ink-soft` at `axis` size. If the newest reading is older than 6 hours the dot becomes `--ink-soft` and the text says "Last synced" with the actual time. Never hide it.

## 8. Motion

One orchestrated moment: the History chart draws its line once on first paint, 400ms, ease-out. Everything else responds to an action and shows what changed, 150–200ms. `prefers-reduced-motion` disables all of it.

## 9. The three modes

Navigation is identical in all three: **Today, Doctors, History**, with everything else under **More**. No mode adds a top-level tab.

**Simple** — one hero metric and at most three cards on Today. History shows one sparkline per metric with the band. Body at 19px, tap targets at 48px. No raw values.

**Standard** — the default. Hero, up to three insights, "Talk to a doctor." Full History chart with chips and ranges. Profile switcher when caregiver or guardian links exist; whose data you are viewing is stated in text on every screen.

**Advanced** — multi-metric overlay up to four series, distinguished by line weight and dash as well as colour. Raw table with source per row, nested in `--surface-2` panels. Baselines shown numerically. Formula disclosure. Padding drops to 12px; type never below 15px; contrast never drops.

Mode is chosen at onboarding, changed under More → Display, stored per profile, never auto-detected. A mode change never alters navigation, alert copy, legal copy, colour roles, chart language, or the accessibility floor.

## 10. Accessibility floor, all modes

- WCAG 2.1 AA: 4.5:1 for text, 3:1 for information-bearing graphics.
- Tap targets 44px minimum, 48px in Simple.
- Visible keyboard focus in `--accent` on every interactive element.
- Text scaling to 200% without loss of function.
- Every chart, icon and state has a text equivalent.
- Tested at 390px wide. No horizontal scroll anywhere.
- No meaning carried by colour alone. Every state pairs colour with an icon and a word.

## 11. Copy

Identical across all three modes. Alerts use the PLAN.md §4.4 template verbatim. Active voice. A button's name and its confirmation match. Errors say what happened and what to do. Empty states are an invitation to act. Sentence case. No exclamation marks. British and Indian English spelling.

## 12. Forbidden

- Any colour not in §4.2.
- `--data` on anything tappable. `--accent` on any chart line. `--urgent` on anything that isn't an urgent alert.
- Tinted or fully-bordered alert cards.
- Streaks, badges, rings-to-close, or any gamification.
- All-caps labels, middle-dot meta strings, monospace data labels.
- Identical rounded cards with a shadow under each. Gradient washes as decoration. Arrows appended to button text.
- Emoji. Illustrations of doctors or stethoscopes.
- A second gradient anywhere.
- Purchase links inside an insight card.

## 13. Self-check before shipping any screen

1. Works at 390px, at 200% text, with reduced motion, by keyboard?
2. Every state legible without colour?
3. Numerals tabular and holding position as values change?
4. Is sage on anything that isn't tappable? Is champagne on anything that is?
5. Does the chart line change ink outside the band, and is the last value labelled?
6. Under 28 days of data, is the band dashed and the count shown?
7. Alert and insight copy match the template exactly?
8. Would a 65-year-old read the primary number without zooming?
9. Would a doctor understand this screenshot with no explanation?
10. Remove one element. Is the screen worse? If not, leave it removed.
