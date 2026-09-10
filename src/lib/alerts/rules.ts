import { z } from "zod";
import { metricTypes, units, type MetricType } from "../ingestion/model";
import { detectAnomalies, type BaselineSet, type Metric } from "../analytics";
import { dayBounds } from "../analytics/time";

export const alertRule = z.object({
  id: z.string(), rule_key: z.string(), metric_type: z.enum(metricTypes), comparator: z.enum(["lt", "lte", "gt", "gte"]),
  threshold_type: z.enum(["absolute", "baseline_deviation"]), value: z.coerce.number().finite(), min_duration_s: z.number().int().min(0).max(86400),
  severity: z.enum(["info", "attention", "urgent"]), enabled: z.boolean(),
});
export type AlertRule = z.infer<typeof alertRule>;
export const defaultRules: AlertRule[] = [
  ["spo2-urgent", "spo2", "lt", "absolute", 90, 600, "urgent"],
  ["spo2-attention", "spo2", "lt", "absolute", 92, 1800, "attention"],
  ["rhr-high", "resting_heart_rate", "gt", "baseline_deviation", 4, 1800, "attention"],
  ["hr-high", "heart_rate", "gt", "absolute", 150, 300, "urgent"],
  ["hr-low", "heart_rate", "lt", "absolute", 40, 300, "urgent"],
  ["skin-temp-high", "skin_temperature", "gt", "baseline_deviation", 4, 1800, "attention"],
  ["bp-systolic", "blood_pressure_systolic", "gte", "absolute", 180, 0, "urgent"],
  ["bp-diastolic", "blood_pressure_diastolic", "gte", "absolute", 120, 0, "urgent"],
  ["skin-temp-low", "skin_temperature", "lt", "baseline_deviation", 4, 1800, "attention"],
].map(([key, metric, comparator, threshold, value, duration, severity], i) => alertRule.parse({ id: "00000000-0000-4000-a000-" + String(i + 1).padStart(12, "0"), rule_key: key, metric_type: metric, comparator, threshold_type: threshold, value, min_duration_s: duration, severity, enabled: true }));

export const metricLabels: Partial<Record<MetricType, string>> = { spo2: "SpO2", heart_rate: "heart rate", resting_heart_rate: "resting heart rate", skin_temperature: "skin/wrist temperature", blood_pressure_systolic: "systolic blood pressure", blood_pressure_diastolic: "diastolic blood pressure" };
export function alertCopy(metric: string, value: string, time: string, emergencyNumber: string) {
  return "Unusual reading: " + metric + " was " + value + " at " + time + ". That's outside your normal range. If you feel unwell, call " + emergencyNumber + " or contact your doctor.";
}
export type AlertMetric = Metric & { at_rest?: boolean | null };
export function evaluateAlerts(metrics: readonly AlertMetric[], baselines: BaselineSet, rules: readonly AlertRule[], options: { day: string; timezone: string; now: Date }) {
  const bounds = dayBounds(options.day, options.timezone);
  const until = Math.min(bounds.end, options.now.getTime());
  const events: { rule: AlertRule; sourceId: string; start: string; end: string; peak: number; peakAt: string; deviation_mads: number | null; duration_s: number; isSample: boolean; valueLabel: string }[] = [];
  for (const rule of rules.filter(r => r.enabled)) {
    const baseline = baselines[rule.metric_type];
    if (rule.threshold_type === "baseline_deviation" && (!baseline || baseline.n < 7 || baseline.median === null)) continue;
    const sources = new Map<string, AlertMetric[]>();
    for (const m of metrics) {
      const at = Date.parse(m.recorded_at);
      if (m.metric_type !== rule.metric_type || at >= until || at < bounds.start - 86400000 || (rule.metric_type.startsWith("blood_pressure") && m.quality !== "user_entered")) continue;
      const key = m.source_id || "unknown", rows = sources.get(key); if (rows) rows.push(m); else sources.set(key, [m]);
    }
    for (const [sourceId, rows] of sources) {
      const series = rows.map(m => ({ recorded_at: m.recorded_at, value: m.value,
        duration_s: m.duration_s === null ? null : Math.min(m.duration_s, Math.max(0, (until - Date.parse(m.recorded_at)) / 1000)),
        at_rest: rule.metric_type === "resting_heart_rate" || m.at_rest === true }));
      for (const event of detectAnomalies(series, baseline ?? null, { ...rule, threshold_type: rule.threshold_type as "absolute" | "baseline_deviation", require_rest: ["heart_rate", "resting_heart_rate"].includes(rule.metric_type) })) {
        if (Date.parse(event.end) < bounds.start || Date.parse(event.start) >= until) continue;
        const peak = event.peak;
        const peakAt = rows.find(m => Math.abs(m.value - peak) < 1e-8 && Date.parse(m.recorded_at) >= Date.parse(event.start) && Date.parse(m.recorded_at) <= Date.parse(event.end))?.recorded_at || event.start;
        events.push({ ...event, peak, peakAt, deviation_mads: event.deviation_mads,
          sourceId, rule, isSample: rows.some(m => m.is_sample), valueLabel: Number(peak.toFixed(2)) + " " + units[rule.metric_type] });
      }
    }
  }
  return events;
}
