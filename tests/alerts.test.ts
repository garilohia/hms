import { afterEach, describe, expect, it, vi } from "vitest";
import { alertCopy, defaultRules, evaluateAlerts, type AlertMetric } from "@/src/lib/alerts/rules";
import { sampleMetrics } from "@/src/lib/ingestion/simulator";
import { dailySummary } from "@/src/lib/analytics";
import { baselinesFor } from "@/src/lib/analytics/derive";
import { units, type MetricType } from "@/src/lib/ingestion/model";
import { cronAuthorised } from "@/src/lib/jobs/cron-auth";
import { emailTransport } from "@/src/lib/alerts/transport";
import { cronCommand, cronEndpoint, cronSchedule } from "@/src/lib/jobs/cron-config";
const options = { day: "2026-06-01", timezone: "UTC", now: new Date("2026-06-02T00:00:00Z") };
const metric = (type: MetricType, value: number, duration: number | null, rest?: boolean): AlertMetric => ({ metric_type: type, value, unit: units[type], duration_s: duration, recorded_at: "2026-06-01T06:00:00Z", quality: "raw", at_rest: rest, source_id: "source" });
afterEach(() => vi.restoreAllMocks());
describe("alert defaults and exact copy", () => {
  it("has every specified system threshold", () => {
    expect(defaultRules.map(r => [r.metric_type, r.comparator, r.value, r.min_duration_s, r.severity])).toEqual([
      ["spo2", "lt", 90, 600, "urgent"], ["spo2", "lt", 92, 1800, "attention"], ["resting_heart_rate", "gt", 4, 1800, "attention"],
      ["heart_rate", "gt", 150, 300, "urgent"], ["heart_rate", "lt", 40, 300, "urgent"], ["skin_temperature", "gt", 4, 1800, "attention"],
      ["blood_pressure_systolic", "gte", 180, 0, "urgent"], ["blood_pressure_diastolic", "gte", 120, 0, "urgent"],
      ["skin_temperature", "lt", 4, 1800, "attention"],
    ]);
    expect(alertCopy("SpO2", "88 %", "10:00", "112")).toBe("Unusual reading: SpO2 was 88 % at 10:00. That's outside your normal range. If you feel unwell, call 112 or contact your doctor.");
  });
  it("fires on persona c, with sample provenance", () => {
    const metrics = [...sampleMetrics("c", 42, options.day)].map(m => ({ ...m, source_id: "sample", is_sample: true }));
    const days = [...new Set(metrics.map(m => m.recorded_at.slice(0, 10)))];
    const summaries = days.map(day => dailySummary(metrics, { day }));
    const events = evaluateAlerts(metrics, baselinesFor(summaries, "2026-05-31"), defaultRules, options);
    expect(events.map(e => e.rule.rule_key)).toEqual(expect.arrayContaining(["spo2-urgent", "spo2-attention", "rhr-high", "skin-temp-high"]));
    expect(events.every(e => e.isSample)).toBe(true);
  });
  it("ignores unknown/exercising heart-rate context, uses explicit rest", () => {
    expect(evaluateAlerts([metric("heart_rate", 160, 300)], {}, defaultRules, options)).toEqual([]);
    expect(evaluateAlerts([metric("heart_rate", 160, 300, false)], {}, defaultRules, options)).toEqual([]);
    expect(evaluateAlerts([metric("heart_rate", 160, 300, true)], {}, defaultRules, options)[0].rule.rule_key).toBe("hr-high");
    expect(evaluateAlerts([metric("heart_rate", 39, 300, true)], {}, defaultRules, options)[0].rule.rule_key).toBe("hr-low");
  });
  it("requires sufficient baseline history and sustained symmetric skin-temperature deviation", () => {
    const metrics = [metric("skin_temperature", 34.5, 1800)];
    expect(evaluateAlerts(metrics, {}, defaultRules, options)).toEqual([]);
    const events = evaluateAlerts(metrics, { skin_temperature: { median: 33.4, mad: .1, n: 28 } }, defaultRules, options);
    expect(events[0].peak).toBe(34.5); expect(events[0].deviation_mads).toBeCloseTo(11);
    expect(evaluateAlerts([metric("skin_temperature", 33.1, 1800)], { skin_temperature: { median: 33.4, mad: .1, n: 28 } }, defaultRules, options)).toEqual([]);
    expect(evaluateAlerts([metric("skin_temperature", 32.9, 1800)], { skin_temperature: { median: 33.4, mad: .1, n: 28 } }, defaultRules, options)[0].rule.rule_key).toBe("skin-temp-low");
  });
  it("does not apply clinical thermometer cutoffs to wearable skin temperature", () => {
    expect(evaluateAlerts([metric("skin_temperature", 38, null)], {}, defaultRules, options)).toEqual([]);
  });
  it("requires explicit user-entered BP and accepts either threshold", () => {
    expect(evaluateAlerts([metric("blood_pressure_systolic", 180, null)], {}, defaultRules, options)).toEqual([]);
    expect(evaluateAlerts([{ ...metric("blood_pressure_systolic", 180, null), quality: "user_entered" }], {}, defaultRules, options)).toHaveLength(1);
    expect(evaluateAlerts([{ ...metric("blood_pressure_diastolic", 120, null), quality: "user_entered" }], {}, defaultRules, options)).toHaveLength(1);
  });
  it("does not borrow duration from future timestamps or another device", () => {
    const future = new Date("2026-06-01T06:04:00Z");
    expect(evaluateAlerts([metric("spo2", 88, 600)], {}, defaultRules, { ...options, now: future })).toEqual([]);
    expect(evaluateAlerts([{ ...metric("spo2", 88, 300), source_id: "a" }, { ...metric("spo2", 88, 300), source_id: "b", recorded_at: "2026-06-01T06:05:00Z" }], {}, defaultRules, options)).toEqual([]);
  });
  it("records the peak's actual timestamp and supports disabled overrides", () => {
    const rows = [metric("spo2", 89, 300), { ...metric("spo2", 88, 300), recorded_at: "2026-06-01T06:05:00Z" }];
    expect(evaluateAlerts(rows, {}, defaultRules, options)[0].peakAt).toBe("2026-06-01T06:05:00Z");
    expect(evaluateAlerts(rows, {}, defaultRules.map(r => ({ ...r, enabled: false })), options)).toEqual([]);
  });
  it("handles empty input and exact minimum duration", () => {
    expect(evaluateAlerts([], {}, defaultRules, options)).toEqual([]);
    expect(evaluateAlerts([metric("spo2", 88, 599)], {}, defaultRules, options)).toEqual([]);
    expect(evaluateAlerts([metric("spo2", 88, 600)], {}, defaultRules, options)).toHaveLength(1);
  });
});
describe("cron and notification boundaries", () => {
  it("keeps minute cadence and credentials in Vault, and rejects local scheduler targets", () => {
    expect(cronSchedule).toBe("* * * * *"); expect(cronCommand).toContain("vault.decrypted_secrets");
    expect(cronEndpoint("https://hms.example.com/path")).toBe("https://hms.example.com/api/jobs/tick");
    for (const url of ["http://localhost:3000", "https://localhost", "https://127.0.0.1", "https://app.local", "https://user:pass@example.com"]) expect(() => cronEndpoint(url)).toThrow();
  });
  it("requires an exact bearer secret of at least 32 characters", () => {
    const key = "a".repeat(40);
    expect(cronAuthorised("Bearer " + key, key)).toBe(true);
    for (const header of [null, key, "Bearer " + key + "x", "Bearer " + "b".repeat(40)]) expect(cronAuthorised(header, key)).toBe(false);
    expect(cronAuthorised("Bearer short", "short")).toBe(false);
    expect(cronAuthorised("Bearer undefined", undefined)).toBe(false);
  });
  it("always stubs sample notifications, even with a configured provider", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await emailTransport({ RESEND_API_KEY: "test" }).send("test", { to: "test@example.com", body: "Sample data", sample: true })).toBe("stubbed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("stubs absent keys without logging health details", async () => {
    const log = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await emailTransport({}).send("fixture", { to: "test@example.com", body: "private", sample: false })).toBe("stubbed");
    expect(log).toHaveBeenCalledWith('{"transport":"email_stub","delivery":"fixture"}\n');
  });
  it("uses a stable Resend idempotency key and bounded request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"id":"test"}'));
    const transport = emailTransport({ RESEND_API_KEY: "test", EMAIL_FROM: "test@example.com" });
    expect(await transport.send("hms-alert/fixture", { to: "other@example.com", body: "test", sample: false })).toBe("sent");
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { "Idempotency-Key": "hms-alert/fixture" } });
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
