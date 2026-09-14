// Verifies DESIGN.md §4.5: every listed text and graphic pair meets its WCAG 2.1 contrast requirement in both modes,
// and app/globals.css declares exactly the hex values in src/lib/design/tokens.ts. Exits non-zero on any failure.
import { readFileSync } from "node:fs";
import { colourTokens, cssVariableNames, type ColourMode, type ColourToken } from "../src/lib/design/tokens";

type Pair = { label: string; foreground: ColourToken; background: ColourToken | "gradient"; requirement: number; documented: Record<ColourMode, number> };

// The documented figures are DESIGN.md §4.5; the script recomputes them and reports any drift.
const pairs: Pair[] = [
  { label: "ink on surface", foreground: "ink", background: "surface", requirement: 4.5, documented: { dark: 13.98, light: 17.10 } },
  { label: "ink on gradient (worst)", foreground: "ink", background: "gradient", requirement: 4.5, documented: { dark: 15.46, light: 15.28 } },
  { label: "ink on surface-2", foreground: "ink", background: "surface2", requirement: 4.5, documented: { dark: 12.47, light: 15.03 } },
  { label: "ink-soft on surface", foreground: "inkSoft", background: "surface", requirement: 4.5, documented: { dark: 6.21, light: 6.05 } },
  { label: "ink-soft on gradient", foreground: "inkSoft", background: "gradient", requirement: 4.5, documented: { dark: 6.86, light: 5.41 } },
  { label: "ink-soft on surface-2", foreground: "inkSoft", background: "surface2", requirement: 4.5, documented: { dark: 5.53, light: 5.32 } },
  { label: "ink-soft on band", foreground: "inkSoft", background: "band", requirement: 4.5, documented: { dark: 5.69, light: 5.14 } },
  { label: "accent on surface", foreground: "accent", background: "surface", requirement: 4.5, documented: { dark: 6.59, light: 6.38 } },
  { label: "on-accent on accent", foreground: "onAccent", background: "accent", requirement: 4.5, documented: { dark: 7.04, light: 6.38 } },
  { label: "urgent on surface", foreground: "urgent", background: "surface", requirement: 4.5, documented: { dark: 4.87, light: 5.57 } },
  { label: "data on band (graphic)", foreground: "data", background: "band", requirement: 3.0, documented: { dark: 8.90, light: 3.57 } },
  { label: "data on surface (graphic)", foreground: "data", background: "surface", requirement: 3.0, documented: { dark: 9.71, light: 4.21 } },
];

function channel(hex: string, offset: number): number {
  const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
export function luminance(hex: string): number {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) throw new Error("Expected a six-digit hex colour, received " + hex);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function cssDeclarations(css: string, mode: ColourMode): Map<string, string> {
  // The light tokens are the first :root block; the dark tokens live inside the prefers-color-scheme block.
  const marker = mode === "light" ? "/* tokens:light */" : "/* tokens:dark */";
  const start = css.indexOf(marker);
  if (start < 0) throw new Error("app/globals.css is missing the " + marker + " marker.");
  const block = css.slice(start, css.indexOf("}", start));
  const found = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\b/g)) found.set(match[1], match[2].toUpperCase());
  return found;
}

const failures: string[] = [];
const drift: string[] = [];
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
for (const mode of ["dark", "light"] as const) {
  const palette = colourTokens[mode];
  const declared = cssDeclarations(css, mode);
  for (const token of Object.keys(cssVariableNames) as ColourToken[]) {
    const name = cssVariableNames[token];
    if (declared.get(name) !== palette[token].toUpperCase()) failures.push(`${mode}: globals.css ${name} is ${declared.get(name) ?? "missing"}, tokens.ts says ${palette[token]}`);
  }
  console.info(`\n${mode} mode`);
  console.info("pair".padEnd(28) + "computed".padStart(9) + "documented".padStart(12) + "requires".padStart(10));
  for (const pair of pairs) {
    const backgrounds = pair.background === "gradient" ? [palette.groundTop, palette.groundBottom] : [palette[pair.background]];
    const ratio = Math.min(...backgrounds.map(background => contrast(palette[pair.foreground], background)));
    const ok = ratio >= pair.requirement;
    console.info(`${pair.label.padEnd(28)}${ratio.toFixed(2).padStart(9)}${pair.documented[mode].toFixed(2).padStart(12)}${pair.requirement.toFixed(1).padStart(10)}  ${ok ? "ok" : "FAIL"}`);
    if (!ok) failures.push(`${mode}: ${pair.label} is ${ratio.toFixed(2)}, needs ${pair.requirement}`);
    if (Math.abs(ratio - pair.documented[mode]) > 0.05) drift.push(`${mode}: ${pair.label} computed ${ratio.toFixed(2)} but DESIGN.md documents ${pair.documented[mode].toFixed(2)}`);
  }
}
// The founder chose the dark urgent #F0554F (D034). It clears 4.5:1 on --surface, where
// every urgent mark actually sits, but not on --surface-2. Rather than trust a comment,
// fail the build if urgent is ever given a --surface-2 background.
const surfaceTwoRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /background(?:-color)?\s*:\s*var\(--surface-2\)/.test(body))
  .map(([, selector]) => selector.trim());
for (const selector of surfaceTwoRules) {
  const scoped = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, candidate, body]) => candidate.includes(selector.split(",")[0].trim()) && /(?:^|[^-])color\s*:\s*var\(--urgent\)/.test(body));
  for (const [, candidate] of scoped) failures.push(`urgent is used on a --surface-2 background in "${candidate.trim()}". DESIGN.md §4.5 forbids this pairing.`);
}

if (drift.length) { console.info("\nDocumented figures that differ from the computed ratio (informational):"); for (const line of drift) console.info("  " + line); }
if (failures.length) { console.error("\nContrast check failed:"); for (const line of failures) console.error("  " + line); process.exit(1); }
console.info("\nAll DESIGN.md §4.5 pairs meet their requirement and globals.css matches tokens.ts.");
