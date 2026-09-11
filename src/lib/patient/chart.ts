// Pure chart geometry for DESIGN.md §5. No DOM, no database: values in, paths out.
import { addDays } from "../analytics/time";
import { computeBaseline, finite } from "../analytics/statistics";
import type { Summary } from "./model";

export type ChartKind = "line" | "bars";
export const chartMetrics={
  RHR:{field:"rhr",unit:"bpm",source:"resting_heart_rate",label:"Resting heart rate",kind:"line"}, HRV:{field:"hrv_avg",unit:"ms",source:"hrv_rmssd",label:"HRV",kind:"line"},
  SpO2:{field:"spo2_avg",unit:"%",source:"spo2",label:"SpO2",kind:"line"}, Sleep:{field:"sleep_duration_min",unit:"min",source:"sleep_duration",label:"Sleep",kind:"bars"},
  Temp:{field:"skin_temp_deviation",unit:"°C from baseline",source:"skin_temperature",label:"Skin temperature",kind:"line"}, Weight:{field:"weight_kg",unit:"kg",source:"weight_kg",label:"Weight",kind:"line"},
  Steps:{field:"steps",unit:"steps",source:"steps",label:"Steps",kind:"bars"}, BP:{field:"bp_systolic",unit:"mmHg (systolic)",source:"blood_pressure_systolic",label:"Blood pressure",kind:"line"},
} as const satisfies Record<string,{field:keyof Summary;unit:string;source:string;label:string;kind:ChartKind}>;
export type ChartMetric=keyof typeof chartMetrics;

export type DayValue = { day: string; value: number | null };
export type ChartPoint = { day: string; value: number | null; x: number; y: number | null };
export type Band = { day: string; low: number; high: number; n: number };
export type ChartLayout = { width: number; height: number; top: number; bottom: number; left: number; right: number };

/** The band is the rolling 28-day median ± 3 MAD (≈ ±2 σ). Alerts fire at 4 MAD, so a line outside the band is unusual but not yet an alert. */
export const BASELINE_WINDOW_DAYS = 28;
export const BASELINE_MIN_DAYS = 7;
export const BAND_MADS = 3;
export const defaultLayout: ChartLayout = { width: 320, height: 160, top: 14, bottom: 14, left: 4, right: 44 };

export function formatDay(day: string): string {
  const date = new Date(day + "T00:00:00Z");
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
export function formatValue(value: number): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

/** Band for one day from the values in the 28-day window ending on that day. Null until seven days exist. */
export function rollingBand(source: readonly DayValue[], day: string): Band | null {
  const baseline = computeBaseline(source.filter(v => v.value !== null).map(v => ({ day: v.day, value: v.value! })), BASELINE_WINDOW_DAYS, day);
  if (baseline.n < BASELINE_MIN_DAYS || !finite(baseline.median) || !finite(baseline.mad)) return null;
  const half = BAND_MADS * baseline.mad;
  return { day, low: baseline.median - half, high: baseline.median + half, n: baseline.n };
}

type Piece = { state: "inside" | "outside"; d: string };

export function buildSeries(input: readonly DayValue[], options: { kind?: ChartKind; baseline?: readonly DayValue[]; layout?: Partial<ChartLayout> } = {}) {
  const kind = options.kind ?? "line";
  const layout: ChartLayout = { ...defaultLayout, ...options.layout };
  const sorted = [...input].filter(v => typeof v.day === "string").sort((a, b) => a.day.localeCompare(b.day));
  const baselineSource = options.baseline ?? sorted;
  const values = sorted.flatMap(v => finite(v.value) ? [v.value] : []);
  const bands = new Map<string, Band>();
  for (const row of sorted) { const band = rollingBand(baselineSource, row.day); if (band) bands.set(row.day, band); }
  const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1;
  const bandLows = [...bands.values()].map(b => b.low), bandHighs = [...bands.values()].map(b => b.high);
  let low = Math.min(min, ...bandLows), high = Math.max(max, ...bandHighs);
  const pad = Math.max(.2, (high - low) * .15);
  low = kind === "bars" && low >= 0 ? 0 : low - pad; high = high + pad;
  const first = Date.parse(sorted[0]?.day ?? "2000-01-01"), last = Date.parse(sorted.at(-1)?.day ?? "2000-01-02");
  const plotWidth = layout.width - layout.left - layout.right, plotHeight = layout.height - layout.top - layout.bottom;
  const x = (day: string) => layout.left + ((Date.parse(day) - first) / Math.max(86400000, last - first)) * plotWidth;
  const y = (value: number) => layout.top + plotHeight - ((value - low) / (high - low)) * plotHeight;
  const points: ChartPoint[] = sorted.map(v => ({ day: v.day, value: finite(v.value) ? v.value : null, x: x(v.day), y: finite(v.value) ? y(v.value) : null }));

  // Break the line at every missing day or missing value. Never fill gaps with zero or interpolate across them.
  const runs: ChartPoint[][] = []; let run: ChartPoint[] = []; let previous: string | null = null;
  for (const point of points) {
    if (point.y === null) { if (run.length) runs.push(run); run = []; previous = null; continue; }
    if (previous && point.day !== addDays(previous, 1)) { if (run.length) runs.push(run); run = []; }
    run.push(point); previous = point.day;
  }
  if (run.length) runs.push(run);
  const segments = runs.map(r => r.map((p, i) => (i ? "L" : "M") + p.x.toFixed(2) + "," + p.y!.toFixed(2)).join(" "));

  // §5.2: split every run at the band boundary. Inside stays --data; outside becomes --ink.
  const state = (p: ChartPoint): Piece["state"] => { const b = bands.get(p.day); return b && (p.value! < b.low || p.value! > b.high) ? "outside" : "inside"; };
  const pieces: Piece[] = [];
  for (const r of runs) {
    let current: Piece = { state: state(r[0]), d: "M" + r[0].x.toFixed(2) + "," + r[0].y!.toFixed(2) };
    for (let i = 1; i < r.length; i++) {
      const p0 = r[i - 1], p1 = r[i], s1 = state(p1);
      if (s1 !== current.state) {
        const b0 = bands.get(p0.day) ?? bands.get(p1.day)!, b1 = bands.get(p1.day) ?? b0;
        const v0 = p0.value!, v1 = p1.value!;
        const above = s1 === "outside" ? v1 > b1.high : v0 > b0.high;
        const e0 = above ? b0.high : b0.low, e1 = above ? b1.high : b1.low;
        const denominator = (v1 - v0) - (e1 - e0);
        const t = denominator === 0 ? 0.5 : Math.min(1, Math.max(0, (e0 - v0) / denominator));
        const cx = p0.x + t * (p1.x - p0.x), cy = y(v0 + t * (v1 - v0));
        current.d += " L" + cx.toFixed(2) + "," + cy.toFixed(2); pieces.push(current);
        current = { state: s1, d: "M" + cx.toFixed(2) + "," + cy.toFixed(2) };
      }
      current.d += " L" + p1.x.toFixed(2) + "," + p1.y!.toFixed(2);
    }
    pieces.push(current);
  }
  const inside = pieces.filter(p => p.state === "inside").map(p => p.d), outside = pieces.filter(p => p.state === "outside").map(p => p.d);

  // Band polygons over consecutive days that have a band.
  const bandPaths: string[] = []; let upper: string[] = [], lower: string[] = []; previous = null;
  const flush = () => { if (upper.length) bandPaths.push("M" + upper.join(" L") + " L" + lower.reverse().join(" L") + " Z"); upper = []; lower = []; };
  for (const point of points) {
    const band = bands.get(point.day);
    if (!band || (previous && point.day !== addDays(previous, 1))) flush();
    if (band) { upper.push(point.x.toFixed(2) + "," + y(band.high).toFixed(2)); lower.push(point.x.toFixed(2) + "," + y(band.low).toFixed(2)); }
    previous = band ? point.day : null;
  }
  flush();

  const lastPoint = [...points].reverse().find(p => p.y !== null) ?? null;
  const lastBand = lastPoint ? rollingBand(baselineSource, lastPoint.day) : null;
  const baselineDays = lastPoint ? computeBaseline(baselineSource.filter(v => v.value !== null).map(v => ({ day: v.day, value: v.value! })), BASELINE_WINDOW_DAYS, lastPoint.day).n : 0;
  const slot = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth;
  const barWidth = Math.max(1, Math.min(14, slot * .65));
  const bars = points.flatMap((p, i) => p.y === null ? [] : [{ day: p.day, x: p.x - barWidth / 2, width: barWidth, y: p.y, height: Math.max(1, layout.top + plotHeight - p.y), latest: i === points.length - 1 }]);
  const gridValues = [high, (high + low) / 2, low];
  return {
    points, segments, inside, outside, bandPaths, bars, kind, layout, min, max, low, high, x, y, gridValues,
    last: lastPoint, lastOutside: lastPoint ? state(lastPoint) === "outside" : false, lastBand,
    baselineDays, building: baselineDays < BASELINE_WINDOW_DAYS, axisY: layout.top + plotHeight,
    firstDay: points[0]?.day ?? null, lastDay: points.at(-1)?.day ?? null,
  };
}
export type ChartSeries = ReturnType<typeof buildSeries>;

/** One-sentence text alternative (§5.5): metric, range, direction, and whether it sits inside the baseline. */
export function describeSeries(label: string, unit: string, series: ChartSeries): string {
  if (!series.last || series.firstDay === null || series.lastDay === null) return label + ": no readings in this range.";
  const valid = series.points.filter(p => p.value !== null);
  const firstValue = valid[0].value!, lastValue = series.last.value!;
  const tolerance = Math.max(Math.abs(firstValue) * .02, (series.high - series.low) * .05);
  const direction = lastValue - firstValue > tolerance ? "rising" : firstValue - lastValue > tolerance ? "falling" : "steady";
  const baseline = series.baselineDays < BASELINE_MIN_DAYS ? "baseline still building" : series.building ? (series.lastOutside ? "outside your usual range while the baseline is still building" : "inside your usual range while the baseline is still building") : series.lastOutside ? "outside your usual range" : "inside your usual range";
  return `${label}, ${formatDay(series.firstDay)} to ${formatDay(series.lastDay)}, ${direction}, latest ${formatValue(lastValue)} ${unit}, ${baseline}.`;
}

export function summaryValues(rows: readonly Summary[], metric: ChartMetric): DayValue[] {
  const field = chartMetrics[metric].field;
  return rows.map(row => ({ day: row.day, value: row[field] as number | null }));
}
export function chartSeries(rows: Summary[], metric: ChartMetric, options: { baseline?: Summary[]; layout?: Partial<ChartLayout> } = {}) {
  const config = chartMetrics[metric];
  const series = buildSeries(summaryValues(rows, metric), { kind: config.kind, baseline: options.baseline ? summaryValues(options.baseline, metric) : undefined, layout: options.layout });
  const byDay = new Map(rows.map(row => [row.day, row]));
  return { ...series, points: series.points.map(p => ({ ...p, row: byDay.get(p.day)! })) };
}
