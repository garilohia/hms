import { describe, expect, it } from "vitest";
import { computeBaseline, dailySummary, detectAnomalies, generateInsights, inferCyclePhase, recoveryExplanation, recoveryScore, deriveHistory, periodsFromFlows, INSIGHT_FOOTER, type BaselineSet, type DailySummary, type Metric } from "@/src/lib/analytics";
import { addDays, dayBounds, localDay } from "@/src/lib/analytics/time";
import { units, type MetricType } from "@/src/lib/ingestion/model";
import { sampleMetrics } from "@/src/lib/ingestion/simulator";

const metric = (type: MetricType, value: number, at = "2026-06-01T06:00:00Z", duration: number | null = null, extra: Partial<Metric> = {}): Metric => ({ metric_type: type, value, unit: units[type], recorded_at: at, duration_s: duration, quality: "raw", ...extra });
const base = (value: number) => ({ median: value, mad: 2, n: 28 });
const baselines: BaselineSet = { resting_heart_rate: base(60), hrv_rmssd: base(50), sleep_duration: base(480), steps: base(8000), stress_score: base(30) };
const summary = (day: string, overrides: Partial<DailySummary> = {}): DailySummary => ({ ...dailySummary([], { day }), rhr: 60, hrv_avg: 50, sleep_duration_min: 480, steps: 8000, stress_avg: 30, readiness_score: 90, skin_temp_deviation: 0, ...overrides });

describe("baselines", () => {
  it("has explicit empty, single-day and zero-MAD results", () => {
    expect(computeBaseline([])).toEqual({ median: null, mad: null, n: 0 });
    expect(computeBaseline([NaN, null, 60])).toEqual({ median: 60, mad: 0, n: 1 });
    expect(computeBaseline([60, 60])).toEqual({ median: 60, mad: 0, n: 2 });
  });
  it("uses median and median absolute deviation, robust to an outlier", () => {
    expect(computeBaseline([1, 2, 3, 4, 100])).toEqual({ median: 3, mad: 1, n: 5 });
  });
  it("uses calendar windows across gaps and aggregates duplicate days once", () => {
    expect(computeBaseline([{ day: "2026-01-01", value: 1000 }, { day: "2026-02-01", value: 60 }, { day: "2026-02-01", value: 80 }, { day: "2026-02-03", value: 50 }], 28, "2026-02-03"))
      .toEqual({ median: 60, mad: 10, n: 2 });
    expect(() => computeBaseline([1], 0)).toThrow();
  });
});
describe("local calendar days and daily summaries", () => {
  it("handles DST spring/fall days, half-hour offsets and a skipped civil day", () => {
    const spring = dayBounds("2026-03-08", "America/New_York"), fall = dayBounds("2026-11-01", "America/New_York");
    expect(spring.end - spring.start).toBe(23 * 3600000);
    expect(fall.end - fall.start).toBe(25 * 3600000);
    expect(new Date(dayBounds("2026-06-01", "Asia/Kolkata").start).toISOString()).toBe("2026-05-31T18:30:00.000Z");
    expect(localDay("2026-05-31T19:00:00Z", "Asia/Kolkata")).toBe("2026-06-01");
    const skipped = dayBounds("2011-12-30", "Pacific/Apia"); expect(skipped.start).toBe(skipped.end);
    expect(() => dayBounds("2026-02-30")).toThrow();
  });
  it("does not turn an empty day or missing metrics into zero readings", () => {
    expect(dailySummary([])).toMatchObject({ day: "", rhr: null, steps: null, sleep_duration_min: null, recovery_score: null });
    expect(dailySummary([metric("steps", 0)])).toMatchObject({ steps: 0, rhr: null });
  });
  it("summarises numeric data and distinguishes night from daytime oxygen", () => {
    const result = dailySummary([metric("resting_heart_rate", 60), metric("resting_heart_rate", 64), metric("hrv_rmssd", 50), metric("spo2", 96, "2026-06-01T02:00:00Z"), metric("spo2", 85, "2026-06-01T14:00:00Z"), metric("steps", 1000), metric("steps", 2000)]);
    expect(result).toMatchObject({ rhr: 62, hrv_avg: 50, spo2_min: 85, night_spo2_min: 96, steps: 3000 });
  });
  it("prorates intervals at local midnight and uses the actual DST day length", () => {
    const split = dailySummary([metric("steps", 2000, "2026-05-31T18:00:00Z", 3600)], { day: "2026-06-01", timezone: "Asia/Kolkata" });
    expect(split.steps).toBe(1000);
    const spring = dayBounds("2026-03-08", "America/New_York");
    const day = dailySummary([metric("steps", 23000, new Date(spring.start).toISOString(), 23 * 3600)], { day: "2026-03-08", timezone: "America/New_York" });
    expect(day.steps).toBe(23000);
  });
  it("does not double-count overlapping sleep, and awake readings override broad asleep spans", () => {
    const result = dailySummary([metric("sleep_stage", 5, "2026-06-01T00:00:00Z", 8 * 3600), metric("sleep_stage", 1, "2026-06-01T00:00:00Z", 8 * 3600), metric("sleep_stage", 3, "2026-06-01T01:00:00Z", 3600), metric("sleep_stage", 4, "2026-06-01T03:00:00Z", 3600), metric("sleep_stage", 0, "2026-06-01T03:30:00Z", 600)]);
    expect(result.sleep_duration_min).toBe(470); expect(result.deep_min).toBe(60); expect(result.rem_min).toBe(50); expect(result.sleep_efficiency).toBe(97.9);
  });
  it("selects one real primary source instead of summing co-worn sample and real devices", () => {
    const result = dailySummary([metric("steps", 3000, undefined, null, { source_id: "sample", is_sample: true }), metric("steps", 1000, undefined, null, { source_id: "real-a" }), metric("steps", 1000, undefined, null, { source_id: "real-b" })]);
    expect(result.steps).toBe(1000); expect(result.source_ids.steps).toBe("real-a"); expect(result.contains_sample).toBe(true);
  });
});
describe("sustained anomalies", () => {
  const rule = { comparator: "lt" as const, threshold_type: "absolute" as const, value: 90, min_duration_s: 600 };
  const readings = (minutes: number[]) => minutes.map(m => ({ recorded_at: new Date(Date.UTC(2026, 5, 1) + m * 60000).toISOString(), value: 88, duration_s: 60 }));
  it("finds a sustained event and never fabricates deviation MADs from a constant baseline", () => {
    const event = detectAnomalies(readings(Array.from({ length: 10 }, (_, i) => i)), { median: 97, mad: 0, n: 28 }, rule);
    expect(event).toHaveLength(1); expect(event[0]).toMatchObject({ duration_s: 600, peak: 88, deviation_mads: null });
  });
  it("handles empty/single points, gaps and unconfirmed resting status", () => {
    expect(detectAnomalies([], null, rule)).toEqual([]);
    expect(detectAnomalies(readings([0]), null, rule)).toEqual([]);
    expect(detectAnomalies(readings([0, 1, 2, 3, 4, 30, 31, 32, 33, 34]), null, rule)).toEqual([]);
    expect(detectAnomalies(readings(Array.from({ length: 10 }, (_, i) => i)), null, { ...rule, require_rest: true })).toEqual([]);
  });
  it("does not infer a sustained interval from a high point followed by a normal point", () => {
    const points = [{ recorded_at: "2026-06-01T00:00:00Z", value: 160 }, { recorded_at: "2026-06-01T00:05:00Z", value: 70 }];
    expect(detectAnomalies(points, null, { comparator: "gt", threshold_type: "absolute", value: 150, min_duration_s: 300, max_gap_s: 300 })).toEqual([]);
  });
  it("truncates a nominal duration when a later reading contradicts it", () => {
    expect(detectAnomalies([{ ...readings([0])[0], duration_s: 600 }, { recorded_at: "2026-06-01T00:02:00Z", value: 97 }], null, rule)).toEqual([]);
  });
  it("computes baseline thresholds and handles absolute timestamps over DST", () => {
    const events = detectAnomalies([{ recorded_at: "2026-11-01T01:55:00-04:00", value: 80, duration_s: 600 }], { median: 60, mad: 4, n: 28 }, { comparator: "gt", threshold_type: "baseline_deviation", value: 4, min_duration_s: 600 });
    expect(events[0]).toMatchObject({ duration_s: 600, deviation_mads: 5, end: "2026-11-01T06:05:00.000Z" });
  });
});
describe("explainable personal recovery", () => {
  it("has equal-weight components and stays in 0–100", () => {
    expect(recoveryScore(60, 50, 480, baselines)).toBe(100);
    expect(recoveryScore(120, 0, 0, baselines)).toBe(0);
    const explanation = recoveryExplanation(66, 40, 240, baselines);
    expect(explanation).toMatchObject({ score: 50, inputs: { rhr: 66, hrv: 40, sleep: 240 }, components: { sleep: 50 } });
    expect(explanation.components?.hrv).toBeCloseTo(50);
  });
  it("withholds scores with empty, missing or single-day baselines", () => {
    expect(recoveryScore(null, 50, 480, baselines)).toBeNull();
    expect(recoveryScore(60, 50, 480, {})).toBeNull();
    expect(recoveryScore(60, 50, 480, { ...baselines, hrv_rmssd: { ...base(50), n: 1 } })).toBeNull();
  });
});
describe("period-anchored cycle estimates", () => {
  const days = Array.from({ length: 28 }, (_, i) => addDays("2026-06-01", i));
  const temperatures = days.map((day, i) => ({ day, value: i >= 15 ? 33.71 : 33.4 }));
  const rates = days.map((day, i) => ({ day, value: i >= 15 ? 64 : 60 }));
  it("returns unknown with a logging prompt without an anchor", () => {
    expect(inferCyclePhase([], [], [], [])).toEqual([]);
    expect(inferCyclePhase(temperatures, rates, [], []).every(p => p.phase === "unknown" && p.prompt?.includes("Log"))).toBe(true);
  });
  it("requires three consecutive raised-temperature days and a resting-HR rise", () => {
    const phases = inferCyclePhase(temperatures, rates, [], [{ start: days[0], end: days[4] }]);
    expect(phases[0]).toMatchObject({ phase: "menstrual", is_inferred: false });
    expect(phases[5].phase).toBe("follicular"); expect(phases[14]).toMatchObject({ phase: "ovulatory", confidence: "low" });
    expect(phases[15]).toMatchObject({ phase: "luteal", is_inferred: true });
    expect(inferCyclePhase(temperatures, rates.map(r => ({ ...r, value: 60 })), [], [{ start: days[0] }]).some(p => p.phase === "luteal")).toBe(false);
  });
  it("does not bridge temperature gaps or infer from a single day", () => {
    const sparse = temperatures.filter((_, i) => i < 15 || i % 2 === 0);
    expect(inferCyclePhase(sparse, rates, [], [{ start: days[0] }]).some(p => p.phase === "luteal")).toBe(false);
    expect(inferCyclePhase([temperatures[20]], [rates[20]], [], [{ start: days[0] }])[0].phase).toBe("unknown");
  });
});
describe("evidence-backed insight rules", () => {
  const week = (overrides: Partial<DailySummary> = {}) => Array.from({ length: 7 }, (_, i) => summary(addDays("2026-06-01", i), overrides));
  it("handles empty and single days without inventing sustained trends", () => {
    expect(generateInsights([], {}, [])).toEqual([]);
    expect(generateInsights([summary("2026-06-01", { sleep_duration_min: 300 })], baselines, [])).toEqual([]);
  });
  it("fires sleep, strain, repeated-night oxygen, temperature and activity rules with footers", () => {
    const result = generateInsights(week({ sleep_duration_min: 400, hrv_avg: 40, rhr: 65, night_spo2_min: 91, skin_temp_deviation: .6, steps: 3000 }), baselines, []);
    expect(result.map(i => i.category)).toEqual(["sleep", "stress", "recovery", "recovery", "activity"]);
    expect(result.every(i => i.body.endsWith(INSIGHT_FOOTER))).toBe(true);
    expect(result.find(i => i.evidence.severity === "attention")).toBeDefined();
  });
  it("does not use daytime oxygen lows as a night insight or bridge gaps for three-day strain", () => {
    const sparse = week({ spo2_min: 85, hrv_avg: 40, rhr: 65 }).filter(d => d.day !== "2026-06-06");
    expect(generateInsights(sparse, baselines, []).some(i => i.category === "stress" || i.evidence.severity === "attention")).toBe(false);
  });
  it("suppresses temperature insight during estimated luteal days and announces transitions", () => {
    const summaries = week({ skin_temp_deviation: .7 });
    const phases = summaries.map((d, i) => ({ day: d.day, phase: i < 6 ? "follicular" as const : "luteal" as const, confidence: "low" as const, is_inferred: true }));
    const result = generateInsights(summaries, baselines, phases);
    expect(result).toHaveLength(1); expect(result[0].category).toBe("cycle");
  });
  it("keeps nutrition prompts low-confidence and free of purchase links", () => {
    const result = generateInsights(week({ sleep_duration_min: 400, stress_avg: 50, hrv_avg: 35, readiness_score: 35, skin_temp_deviation: -.2 }), baselines, []).filter(i => i.category === "nutrition_ask_doctor");
    expect(result).toHaveLength(2);
    expect(result.every(i => i.confidence === "low" && i.title.startsWith("Worth asking your doctor about") && i.body.endsWith(INSIGHT_FOOTER) && !i.body.includes("http"))).toBe(true);
  });
});

describe("sample-persona analysis pipeline", () => {
  it.each(["Asia/Kolkata", "America/New_York"])("keeps 90 complete local sample days in %s, including DST", timezone => {
    const metrics = [...sampleMetrics("b", 42, "2026-03-10", timezone)];
    expect(new Set(metrics.map(m => localDay(m.recorded_at, timezone))).size).toBe(90);
    const days = [...new Set(metrics.map(m => localDay(m.recorded_at, timezone)))].sort();
    const raw = days.map(day => dailySummary(metrics, { day, timezone }));
    const periods = periodsFromFlows(metrics.filter(m => m.metric_type === "menstrual_flow").map(m => ({ day: localDay(m.recorded_at, timezone), value: m.value })));
    const result = deriveHistory(raw, periods);
    expect(result.insights.some(i => i.category === "cycle")).toBe(true);
    expect(result.summaries.at(-1)?.recovery_score).not.toBeNull();
  });
  it.each(["a", "b", "c"] as const)("derives persona %s from normalised samples without mutating inputs", persona => {
    const metrics = [...sampleMetrics(persona, 42, "2026-09-08")].map(m => ({ ...m, is_sample: true, source_id: "sample" }));
    const byDay = new Map<string, Metric[]>();
    for (const m of metrics) { const day = m.recorded_at.slice(0, 10), rows = byDay.get(day); if (rows) rows.push(m); else byDay.set(day, [m]); }
    const raw = [...byDay].map(([day, rows]) => dailySummary(rows, { day }));
    const before = JSON.stringify(raw);
    const flows = metrics.filter(m => m.metric_type === "menstrual_flow").map(m => ({ day: m.recorded_at.slice(0, 10), value: m.value }));
    const derived = deriveHistory(raw, periodsFromFlows(flows));
    expect(JSON.stringify(raw)).toBe(before);
    expect(derived.summaries).toHaveLength(90); expect(derived.summaries[89].recovery_score).not.toBeNull();
    expect(derived.summaries.every(d => d.contains_sample)).toBe(true);
    if (persona === "b") { expect(derived.insights.some(i => i.category === "cycle")).toBe(true); expect(derived.phases.some(p => p.phase === "luteal")).toBe(true); }
    if (persona === "c") expect(derived.insights.some(i => i.title === "Your body shows signs of strain.")).toBe(true);
  });
});
