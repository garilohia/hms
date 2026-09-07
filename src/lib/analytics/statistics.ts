import type { Baseline, DayValue } from "./types";
import { addDays, validDay } from "./time";

export function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
export function median(values: readonly number[]): number | null {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const n = sorted.length;
  return n ? n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : null;
}
export function mean(values: readonly number[]): number | null { const valid = values.filter(finite); return valid.length ? valid.reduce((sum, v) => sum + v, 0) / valid.length : null; }
export function computeBaseline(values: readonly (number | null | DayValue)[], windowDays = 28, asOfDay?: string): Baseline {
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error("Baseline window must be a positive number of days.");
  const timed = values.filter((v): v is DayValue => v !== null && typeof v === "object" && validDay(v.day));
  let samples: number[];
  if (timed.length) {
    const end = asOfDay || timed.map(v => v.day).sort().at(-1)!;
    const start = addDays(end, 1 - windowDays);
    // One daily observation prevents high-frequency devices dominating baseline n.
    const byDay = new Map<string, number[]>();
    for (const row of timed) if (row.day >= start && row.day <= end && finite(row.value)) {
      const group = byDay.get(row.day);
      if (group) group.push(row.value); else byDay.set(row.day, [row.value]);
    }
    samples = [...byDay.values()].map(v => median(v)!).filter(finite);
  } else samples = values.slice(-windowDays).filter(finite);
  const centre = median(samples);
  return { median: centre, mad: centre === null ? null : median(samples.map(v => Math.abs(v - centre))), n: samples.length };
}
export const clamp = (n: number, low = 0, high = 100) => Math.max(low, Math.min(high, n));
