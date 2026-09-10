import { finite } from "./statistics";
import type { Baseline } from "./types";

export type Reading = { recorded_at: string; value: number; duration_s?: number | null; at_rest?: boolean };
export type AnomalyRule = { comparator: "lt" | "lte" | "gt" | "gte"; threshold_type: "absolute" | "baseline_deviation"; value: number; min_duration_s: number; require_rest?: boolean; max_gap_s?: number };
export type Anomaly = { start: string; end: string; peak: number; deviation_mads: number | null; duration_s: number };
export function detectAnomalies(series: readonly Reading[], baseline: Baseline | null, rule: AnomalyRule): Anomaly[] {
  const low = rule.comparator === "lt" || rule.comparator === "lte";
  const threshold = rule.threshold_type === "absolute" ? rule.value : finite(baseline?.median) && finite(baseline?.mad)
    ? baseline.median + (low ? -1 : 1) * rule.value * baseline.mad : null;
  if (!finite(threshold)) return [];
  const matches = (v: number) => rule.comparator === "lt" ? v < threshold : rule.comparator === "lte" ? v <= threshold : rule.comparator === "gt" ? v > threshold : v >= threshold;
  const rows = series.filter(r => finite(r.value) && Number.isFinite(Date.parse(r.recorded_at))).slice().sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  const events: Anomaly[] = [];
  let active: { start: number; end: number; peak: number } | null = null;
  const finish = () => {
    if (active && (active.end - active.start) / 1000 >= rule.min_duration_s) events.push({ start: new Date(active.start).toISOString(), end: new Date(active.end).toISOString(), peak: active.peak,
      duration_s: (active.end - active.start) / 1000, deviation_mads: baseline?.mad && finite(baseline.median) ? Math.abs(active.peak - baseline.median) / baseline.mad : null });
    active = null;
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], start = Date.parse(r.recorded_at);
    if (!matches(r.value) || (rule.require_rest && r.at_rest !== true)) {
      if (active) active.end = Math.min(active.end, start);
      finish(); continue;
    }
    const next = rows[i + 1] ? Date.parse(rows[i + 1].recorded_at) : start;
    // Missing duration may extend only as far as the next nearby observation.
    // A data gap is never counted as sustained evidence; the last point is zero-length.
    const nextQualifies = rows[i + 1] && matches(rows[i + 1].value) && (!rule.require_rest || rows[i + 1].at_rest === true);
    const duration = r.duration_s && r.duration_s > 0 ? r.duration_s * 1000 : nextQualifies && next - start <= (rule.max_gap_s ?? 120) * 1000 ? next - start : 0;
    const end = start + duration;
    if (active && start <= active.end) { active.end = Math.max(active.end, end); active.peak = low ? Math.min(active.peak, r.value) : Math.max(active.peak, r.value); }
    else { finish(); active = { start, end, peak: r.value }; }
  }
  finish(); return events;
}
