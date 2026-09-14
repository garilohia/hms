// DESIGN.md §4 colour tokens. This file and app/globals.css are the only two places a hex value may live.
// scripts/check-contrast.ts verifies that globals.css matches these values and that every §4.5 pair meets WCAG 2.1.

export const colourTokens = {
  light: {
    groundTop: "#FAF9F6", groundBottom: "#F4F2ED",
    surface: "#FFFFFF", surface2: "#F3F0EA", rule: "#E9E4DC", ruleLit: "#E9E4DC",
    ink: "#201B14", inkSoft: "#6B6156", band: "#F0ECE4",
    accent: "#1E6B55", onAccent: "#FFFFFF", data: "#8A7A52", urgent: "#C8262C",
  },
  dark: {
    groundTop: "#17130F", groundBottom: "#100D0A",
    surface: "#221D18", surface2: "#2D2620", rule: "#342D26", ruleLit: "#443B32",
    ink: "#F0EAE2", inkSoft: "#A79C90", band: "#2B241C",
    accent: "#57B394", onAccent: "#0D1A15", data: "#D4C4A0", urgent: "#F0554F",
  },
} as const;

export type ColourMode = keyof typeof colourTokens;
export type ColourToken = keyof typeof colourTokens.light;

// CSS custom property name for each token, as declared in app/globals.css.
export const cssVariableNames: Record<ColourToken, string> = {
  groundTop: "--ground-top", groundBottom: "--ground-bottom",
  surface: "--surface", surface2: "--surface-2", rule: "--rule", ruleLit: "--rule-lit",
  ink: "--ink", inkSoft: "--ink-soft", band: "--band",
  accent: "--accent", onAccent: "--on-accent", data: "--data", urgent: "--urgent",
};

// Type scale, rem on a 17px root (§4.6).
export const typeScale = {
  hero: { rem: 3.25, family: "serif", weight: 400, tracking: "-0.02em" },
  title: { rem: 1.5, family: "serif", weight: 500 },
  section: { rem: 1.125, family: "sans", weight: 600 },
  body: { rem: 1, family: "sans", weight: 400, lineHeight: 1.55 },
  label: { rem: 0.875, family: "sans", weight: 500 },
  axis: { rem: 0.75, family: "sans", weight: 400 },
} as const;

export const rootFontSizePx = 17;
// Founder override of DESIGN.md §4.7 (D030): Apple-like scale with continuous corners where the browser supports corner-shape.
export const radius = { input: 10, button: 14, card: 20, sheet: 28 } as const;
export const spacing = { unit: 4, cardPadding: 20, sectionGap: 32 } as const;
