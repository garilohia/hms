import type { MetricType, NormalisedMetric } from "../ingestion/model";

export type Metric = Pick<NormalisedMetric, "metric_type" | "value" | "unit" | "recorded_at" | "duration_s" | "quality"> & { source_id?: string; is_sample?: boolean };
export type DayValue = { day: string; value: number | null };
export type Baseline = { median: number | null; mad: number | null; n: number };
export type BaselineSet = Partial<Record<MetricType, Baseline>>;
export type DailySummary = {
  day: string; rhr: number | null; hrv_avg: number | null; spo2_min: number | null; spo2_avg: number | null; night_spo2_min: number | null;
  skin_temp_avg: number | null; skin_temp_deviation: number | null; sleep_duration_min: number | null; sleep_efficiency: number | null;
  deep_min: number | null; rem_min: number | null; steps: number | null; active_calories: number | null; stress_avg: number | null;
  weight_kg: number | null; bp_systolic: number | null; bp_diastolic: number | null;
  recovery_score: number | null; readiness_score: number | null; contains_sample: boolean; source_ids: Partial<Record<MetricType, string>>;
  metric_values: Partial<Record<MetricType, number>>;
};
export type CyclePhaseName = "menstrual" | "follicular" | "ovulatory" | "luteal" | "unknown";
export type CyclePhase = { day: string; phase: CyclePhaseName; confidence: "low" | "medium" | "high"; is_inferred: boolean; prompt?: string };
export type PeriodLog = { start: string; end?: string | null };
export const INSIGHT_FOOTER = "Discuss with your doctor.";
export type Insight = {
  category: "sleep" | "stress" | "recovery" | "cycle" | "activity" | "nutrition_ask_doctor";
  title: string; body: string; confidence: "low" | "medium" | "high"; evidence: Record<string, unknown>;
};
