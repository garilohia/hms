import { describe, expect, it } from "vitest";
import { normaliseGoogle } from "@/src/lib/integrations/normalise";

describe("Google Health normalisation", () => {
  it("maps intraday heart rate with its original observation time", () => {
    const [reading] = normaliseGoogle({ heartRate: { sampleTime: { physicalTime: "2026-09-10T06:01:03Z" }, beatsPerMinute: "72" } }, "heart-rate", "Asia/Kolkata");
    expect(reading).toMatchObject({ metric_type: "heart_rate", value: 72, unit: "bpm", recorded_at: "2026-09-10T06:01:03Z", quality: "raw" });
    expect(reading.at_rest).toBeUndefined();
  });
  it("maps daily Fitbit/Google measurements in the profile timezone", () => {
    const [reading] = normaliseGoogle({ dailyRestingHeartRate: { date: { year: 2026, month: 9, day: 10 }, beatsPerMinute: "61" } }, "daily-resting-heart-rate", "Asia/Kolkata");
    expect(reading).toMatchObject({ metric_type: "resting_heart_rate", value: 61, unit: "bpm", recorded_at: "2026-09-09T18:30:00.000Z", at_rest: true, quality: "derived" });
  });

  it("preserves interval duration and converts weight grams", () => {
    const [steps] = normaliseGoogle({ steps: { count: "420", interval: { startTime: "2026-09-10T01:00:00Z", endTime: "2026-09-10T01:10:00Z" } } }, "steps", "UTC");
    expect(steps).toMatchObject({ metric_type: "steps", value: 420, duration_s: 600 });
    const [weight] = normaliseGoogle({ weight: { weightGrams: 72500, sampleTime: { physicalTime: "2026-09-10T06:00:00Z" } } }, "weight", "UTC");
    expect(weight).toMatchObject({ metric_type: "weight_kg", value: 72.5, unit: "kg" });
  });

  it("uses sleep minutes and rejects unsupported payloads", () => {
    const [sleep] = normaliseGoogle({ sleep: { interval: { startTime: "2026-09-09T20:00:00Z", endTime: "2026-09-10T04:00:00Z" }, summary: { minutesAsleep: "450" } } }, "sleep", "UTC");
    expect(sleep).toMatchObject({ metric_type: "sleep_duration", value: 450, duration_s: 27000 });
    expect(normaliseGoogle({ accountSettings: {} }, "account-settings", "UTC")).toEqual([]);
  });
});
