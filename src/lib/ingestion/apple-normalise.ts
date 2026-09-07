import { z } from "zod";
import { canonicalMetric, sleepStages, units, type MetricType, type NormalisedMetric } from "./model";

const appleRecord = z.object({ type: z.string(), value: z.string(), startDate: z.string(), endDate: z.string().optional(), unit: z.string().optional(), sourceName: z.string().optional(), device: z.string().optional() });
const mapping: Record<string, MetricType> = {
  HeartRate: "heart_rate", RestingHeartRate: "resting_heart_rate", OxygenSaturation: "spo2",
  AppleSleepingWristTemperature: "skin_temperature", RespiratoryRate: "respiratory_rate", StepCount: "steps",
  ActiveEnergyBurned: "active_calories", BodyMass: "weight_kg", BodyFatPercentage: "body_fat_pct",
  BloodPressureSystolic: "blood_pressure_systolic", BloodPressureDiastolic: "blood_pressure_diastolic",
  BloodGlucose: "blood_glucose", VO2Max: "vo2max", BasalBodyTemperature: "basal_body_temperature",
  SleepAnalysis: "sleep_stage", MenstrualFlow: "menstrual_flow",
};
const appleSleep: Record<string, number> = {
  HKCategoryValueSleepAnalysisAwake: sleepStages.awake, HKCategoryValueSleepAnalysisAsleep: sleepStages.asleep,
  HKCategoryValueSleepAnalysisAsleepUnspecified: sleepStages.asleep, HKCategoryValueSleepAnalysisAsleepCore: sleepStages.core,
  HKCategoryValueSleepAnalysisAsleepDeep: sleepStages.deep, HKCategoryValueSleepAnalysisAsleepREM: sleepStages.rem,
  HKCategoryValueSleepAnalysisInBed: sleepStages.in_bed,
};
const flow: Record<string, number> = { HKCategoryValueMenstrualFlowUnspecified: 1, HKCategoryValueMenstrualFlowLight: 2, HKCategoryValueMenstrualFlowMedium: 3, HKCategoryValueMenstrualFlowHeavy: 4, HKCategoryValueMenstrualFlowNone: 0 };
export function appleTimestamp(value: string): string | null {
  const canonical = value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/, "$1T$2$3:$4");
  if (!z.iso.datetime({ offset: true }).safeParse(canonical).success) return null;
  const epoch = Date.parse(canonical);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}
function deviceIdentity(sourceName?: string, device?: string): string | null {
  // HKDevice's leading memory address is not stable across exports. Keep its
  // device descriptors/identifier, never the pointer or software version.
  const fields = [...(device || "").matchAll(/(?:name|manufacturer|model|hardware|localIdentifier):\s*([^,>]+)/g)].map(m => m[0].trim());
  const identity = [(sourceName || "Apple Health"), ...fields].join(" · ");
  // Never truncate an identity: two devices could then silently share a dedupe key.
  return identity.length <= 200 ? identity : null;
}
export function normaliseApple(raw: unknown): NormalisedMetric[] {
  const parsed = appleRecord.safeParse(raw);
  if (!parsed.success) return [];
  const r = parsed.data;
  const device = deviceIdentity(r.sourceName, r.device);
  if (!device) return [];
  const metric_type = mapping[r.type.replace(/^HK(?:Quantity|Category)TypeIdentifier/, "")];
  // Apple's HRV is SDNN, not RMSSD. Neither SDNN nor basal-energy-only samples
  // can honestly be renamed to our RMSSD/total-calorie metrics; skip them.
  if (!metric_type) return [];
  const recorded_at = appleTimestamp(r.startDate);
  const end = r.endDate ? appleTimestamp(r.endDate) : recorded_at;
  if (!recorded_at || !end) return [];
  const duration_s = Math.round((Date.parse(end) - Date.parse(recorded_at)) / 1000);
  let value = r.value.trim() === "" ? NaN : Number(r.value);
  const unit = units[metric_type];
  if (metric_type === "sleep_stage") value = appleSleep[r.value] ?? NaN;
  else if (metric_type === "menstrual_flow") value = flow[r.value] ?? NaN;
  else if ((metric_type === "spo2" || metric_type === "body_fat_pct") && r.unit === "%") value *= 100;
  else if ((metric_type === "skin_temperature" || metric_type === "basal_body_temperature") && r.unit === "degF") value = (value - 32) * 5 / 9;
  else if (metric_type === "weight_kg" && r.unit === "lb") value *= .45359237;
  else if (metric_type === "blood_glucose" && r.unit === "mmol/L") value *= 18.0182;
  else if (metric_type === "active_calories" && r.unit === "kJ") value /= 4.184;
  else {
    const accepted = [unit];
    if (unit === "°C") accepted.push("degC");
    if (unit === "bpm" || unit === "breaths/min") accepted.push("count/min");
    if (unit === "mL/kg/min") accepted.push("mL/min·kg");
    if (!r.unit || !accepted.includes(r.unit)) return [];
  }
  return canonicalMetric({ metric_type, value, unit, recorded_at, duration_s,
    quality: metric_type === "menstrual_flow" ? "user_entered" : "raw", external_id: null,
    device });
}
