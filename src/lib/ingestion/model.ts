import { z } from "zod";

export const metricTypes = ["heart_rate", "resting_heart_rate", "hrv_rmssd", "spo2", "skin_temperature", "respiratory_rate", "steps", "active_calories", "total_calories", "sleep_stage", "sleep_duration", "stress_score", "weight_kg", "body_fat_pct", "blood_pressure_systolic", "blood_pressure_diastolic", "blood_glucose", "vo2max", "menstrual_flow", "basal_body_temperature"] as const;
export type MetricType = typeof metricTypes[number];
export const providers = ["simulator", "apple_health_export", "fitbit_export", "garmin_export", "generic_csv", "fitbit_api", "google_health_api", "whoop_api", "aggregator"] as const;
export type Provider = typeof providers[number];
export const units: Record<MetricType, string> = {
  heart_rate: "bpm", resting_heart_rate: "bpm", hrv_rmssd: "ms", spo2: "%", skin_temperature: "°C",
  respiratory_rate: "breaths/min", steps: "count", active_calories: "kcal", total_calories: "kcal",
  sleep_stage: "stage", sleep_duration: "min", stress_score: "score", weight_kg: "kg", body_fat_pct: "%",
  blood_pressure_systolic: "mmHg", blood_pressure_diastolic: "mmHg", blood_glucose: "mg/dL",
  vo2max: "mL/kg/min", menstrual_flow: "category", basal_body_temperature: "°C",
};
// Stable numerical categories, not vendor category numbers.
export const sleepStages = { awake: 0, asleep: 1, core: 2, deep: 3, rem: 4, in_bed: 5 } as const;
export const normalisedMetric = z.object({
  metric_type: z.enum(metricTypes), value: z.number().finite().min(-1e9).max(1e9), unit: z.string().max(24),
  recorded_at: z.iso.datetime({ offset: true }).refine(s => Number.isFinite(Date.parse(s))),
  duration_s: z.number().int().min(0).max(604800).nullable().default(null),
  at_rest: z.boolean().nullable().optional(),
  quality: z.enum(["raw", "derived", "user_entered"]).default("raw"),
  external_id: z.string().max(200).nullable().default(null), device: z.string().trim().min(1).max(200).optional(),
}).strict().refine(m => m.unit === units[m.metric_type], "Use the canonical unit for this metric.")
  .refine(m => m.metric_type !== "sleep_stage" || (Number.isInteger(m.value) && m.value >= 0 && m.value <= 5), "Invalid sleep stage.");
export type NormalisedMetric = z.infer<typeof normalisedMetric>;
export const BATCH_SIZE = 1000;
export const MAX_BODY_BYTES = 1024 * 1024;
export const sourceInput = z.object({ userId: z.uuid(), provider: z.enum(["simulator", "generic_csv", "apple_health_export"]), key: z.string().trim().min(1).max(200) }).strict();
export const batchInput = z.object({ userId: z.uuid(), sourceId: z.uuid(), metrics: z.array(normalisedMetric).min(1).max(BATCH_SIZE) }).strict();
export type DataSource = { id: string; userId: string; provider: Provider; key: string };
export type SyncResult = { inserted: number; skipped: number; errors: string[] };
export interface DataSourceAdapter {
  provider: Provider;
  connect(userId: string, input: unknown): Promise<DataSource>;
  sync(source: DataSource): Promise<SyncResult>;
  normalise(raw: unknown): NormalisedMetric[];
}
export interface IngestionTransport {
  connect(userId: string, provider: Provider, key: string): Promise<DataSource>;
  persist(source: DataSource, metrics: NormalisedMetric[]): Promise<{ inserted: number; skipped: number }>;
}

export function canonicalMetric(raw: unknown): NormalisedMetric[] {
  const parsed = normalisedMetric.safeParse(raw);
  return parsed.success ? [parsed.data] : [];
}
