import { metricTypes, type MetricType } from "../ingestion/model";
import { finite, mean, median } from "./statistics";
import { dayBounds, localDay, localHour } from "./time";
import type { DailySummary, Metric } from "./types";

type Interval = [number, number];
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const result: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else result.push([a, b]);
  }
  return result;
}
function unionDuration(intervals: Interval[]): number { return mergeIntervals(intervals).reduce((sum, [a, b]) => sum + b - a, 0) / 60000; }
function durationWithout(intervals: Interval[], excluded: Interval[]): number {
  const cuts = mergeIntervals(excluded);
  let total = 0;
  for (const [a, b] of mergeIntervals(intervals)) {
    total += b - a;
    for (const [c, d] of cuts) {
      if (c >= b) break;
      total -= Math.max(0, Math.min(b, d) - Math.max(a, c));
    }
  }
  return total / 60000;
}
/** Select a consistent primary source per metric/day, preferring real readings,
 * then duration coverage/sample count and a stable ID tie-break. This avoids
 * counting two co-worn devices twice. Raw History retains all source readings. */
export function primarySource(rows: readonly Metric[]) {
  const groups = new Map<string, Metric[]>();
  for (const m of rows) {
    const key = m.source_id || "default", group = groups.get(key);
    if (group) group.push(m); else groups.set(key, [m]);
  }
  const rank = (r: Metric[]) => r.reduce((n, m) => n + Math.max(m.duration_s || 0, 1), 0);
  return [...groups.entries()].sort((a, b) => Number(a[1].every(m => m.is_sample)) - Number(b[1].every(m => m.is_sample)) || rank(b[1]) - rank(a[1]) || a[0].localeCompare(b[0]))[0]?.[1] || [];
}
export function dailySummary(metricsForDay: readonly Metric[], options: { day?: string; timezone?: string } = {}): DailySummary {
  const timezone = options.timezone || "UTC";
  const valid = metricsForDay.filter(m => finite(m.value) && Number.isFinite(Date.parse(m.recorded_at)));
  const day = options.day || (valid.length ? localDay(valid[0].recorded_at, timezone) : "");
  const bounds = day ? dayBounds(day, timezone) : { start: 0, end: 0 };
  const interval = (m: Metric): Interval => [Math.max(bounds.start, Date.parse(m.recorded_at)), Math.min(bounds.end, Date.parse(m.recorded_at) + Math.max(0, m.duration_s || 0) * 1000)];
  const overlaps = (m: Metric) => {
    const start = Date.parse(m.recorded_at), end = start + Math.max(0, m.duration_s || 0) * 1000;
    return (start >= bounds.start && start < bounds.end) || (start < bounds.end && end > bounds.start);
  };
  const inDay = valid.filter(overlaps);
  const sources: DailySummary["source_ids"] = {};
  const selected = new Map<MetricType, Metric[]>();
  for (const type of metricTypes) {
    const rows = primarySource(inDay.filter(m => m.metric_type === type));
    selected.set(type, rows);
    if (rows[0]?.source_id) sources[type] = rows[0].source_id;
  }
  const rows = (type: MetricType) => selected.get(type)!;
  const values = (type: MetricType) => rows(type).map(m => m.value);
  const average = (type: MetricType) => mean(values(type));
  const minimum = (v: number[]) => v.length ? v.reduce((n, x) => Math.min(n, x), Infinity) : null;
  const sum = (type: MetricType) => rows(type).length ? rows(type).reduce((total, m) => {
    const [a, b] = interval(m);
    return total + m.value * (m.duration_s ? Math.max(0, b - a) / (m.duration_s * 1000) : 1);
  }, 0) : null;
  const stages = rows("sleep_stage");
  const asleep = stages.filter(m => [1, 2, 3, 4].includes(m.value));
  const awake = stages.filter(m => m.value === 0).map(interval);
  const inBed = stages.filter(m => m.value === 5);
  const asleepMin = asleep.length ? durationWithout(asleep.map(interval), awake) : null;
  const bedMin = inBed.length ? unionDuration(inBed.map(interval)) : null;
  const stageMin = (value: number) => stages.some(m => m.value === value) ? durationWithout(stages.filter(m => m.value === value).map(interval),
    [...awake, ...stages.filter(m => m.value !== value && [2, 3, 4].includes(m.value)).map(interval)]) : null;
  const night = rows("spo2").filter(m => { const hour = localHour(m.recorded_at, timezone); return hour >= 22 || hour < 9; }).map(m => m.value);
  const metricValues: DailySummary["metric_values"] = {};
  for (const type of metricTypes) {
    if (type === "sleep_stage" || type === "menstrual_flow") continue;
    const value = ["steps", "active_calories", "total_calories", "sleep_duration"].includes(type) ? sum(type) : average(type);
    if (value !== null) metricValues[type] = value;
  }
  return {
    day, rhr: median(values("resting_heart_rate")), hrv_avg: average("hrv_rmssd"), spo2_min: minimum(values("spo2")), spo2_avg: average("spo2"), night_spo2_min: minimum(night),
    skin_temp_avg: average("skin_temperature"), skin_temp_deviation: null,
    sleep_duration_min: sum("sleep_duration") ?? asleepMin,
    sleep_efficiency: asleepMin !== null && bedMin && asleepMin <= bedMin ? Math.round(1000 * asleepMin / bedMin) / 10 : null,
    deep_min: stageMin(3), rem_min: stageMin(4), steps: sum("steps"), active_calories: sum("active_calories"), stress_avg: average("stress_score"),
    weight_kg: median(values("weight_kg")), bp_systolic: median(values("blood_pressure_systolic")), bp_diastolic: median(values("blood_pressure_diastolic")),
    recovery_score: null, readiness_score: null, contains_sample: inDay.some(m => m.is_sample === true), source_ids: sources, metric_values: metricValues,
  };
}
