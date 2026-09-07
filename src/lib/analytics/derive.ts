import { metricTypes, type MetricType } from "../ingestion/model";
import { inferCyclePhase } from "./cycle";
import { generateInsights } from "./insights";
import { recoveryExplanation } from "./recovery";
import { computeBaseline, finite } from "./statistics";
import { addDays, validDay } from "./time";
import type { BaselineSet, DailySummary, DayValue, PeriodLog } from "./types";

const summaryFields: Partial<Record<MetricType, keyof DailySummary>> = {
  resting_heart_rate: "rhr", hrv_rmssd: "hrv_avg", spo2: "spo2_avg", skin_temperature: "skin_temp_avg",
  sleep_duration: "sleep_duration_min", steps: "steps", active_calories: "active_calories", stress_score: "stress_avg",
  weight_kg: "weight_kg", blood_pressure_systolic: "bp_systolic", blood_pressure_diastolic: "bp_diastolic",
};
export function baselinesFor(summaries: readonly DailySummary[], endDay: string): BaselineSet {
  const result: BaselineSet = {};
  for (const type of metricTypes) {
    if (type === "sleep_stage" || type === "menstrual_flow") continue;
    const field = summaryFields[type];
    result[type] = computeBaseline(summaries.map(d => {
      const value = field ? d[field] : d.metric_values[type];
      return { day: d.day, value: finite(value) ? value : null };
    }), 28, endDay);
  }
  return result;
}
/** Positive menstrual-flow records are explicit logged observations (including
 * clearly labelled simulator logs), never an inference from physiological data. */
export function periodsFromFlows(flows: readonly DayValue[]): PeriodLog[] {
  const days = [...new Set(flows.filter(f => validDay(f.day) && finite(f.value) && f.value > 0).map(f => f.day))].sort();
  const periods: PeriodLog[] = [];
  for (const day of days) {
    const last = periods.at(-1);
    if (last?.end && addDays(last.end, 1) === day) last.end = day;
    else periods.push({ start: day, end: day });
  }
  return periods;
}
export function deriveHistory(raw: readonly DailySummary[], periods: readonly PeriodLog[]) {
  const sorted = [...new Map(raw.filter(d => validDay(d.day)).map(d => [d.day, d])).values()].sort((a, b) => a.day.localeCompare(b.day));
  const evidence = new Map<string, ReturnType<typeof recoveryExplanation>>();
  const summaries = sorted.map((day, i) => {
    const prior = sorted.slice(Math.max(0, i - 28), i);
    const baseline = baselinesFor(prior, addDays(day.day, -1));
    const recovery = recoveryExplanation(day.rhr, day.hrv_avg, day.sleep_duration_min, baseline);
    evidence.set(day.day, recovery);
    const temperature = baseline.skin_temperature;
    return { ...day, recovery_score: recovery.score, readiness_score: recovery.score,
      skin_temp_deviation: finite(day.skin_temp_avg) && temperature && temperature.n >= 7 && finite(temperature.median) ? day.skin_temp_avg - temperature.median : null };
  });
  const latest = summaries.at(-1);
  const baselines = latest ? baselinesFor(summaries, addDays(latest.day, -1)) : {};
  const phases = inferCyclePhase(summaries.map(d => ({ day: d.day, value: d.skin_temp_avg })), summaries.map(d => ({ day: d.day, value: d.rhr })), summaries.map(d => ({ day: d.day, value: d.hrv_avg })), periods);
  return { summaries, baselines, phases, insights: generateInsights(summaries, baselines, phases), evidence };
}
