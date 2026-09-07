import { clamp, finite } from "./statistics";
import type { BaselineSet } from "./types";

export function recoveryExplanation(rhr: number | null, hrv: number | null, sleep: number | null, baseline: BaselineSet) {
  const resting = baseline.resting_heart_rate, variability = baseline.hrv_rmssd, duration = baseline.sleep_duration;
  if (!finite(rhr) || !finite(hrv) || !finite(sleep) || rhr <= 0 || hrv < 0 || sleep < 0 || !resting || !variability || !duration ||
      Math.min(resting.n, variability.n, duration.n) < 7 || !finite(resting.median) || !finite(variability.median) || !finite(duration.median) ||
      variability.median <= 0 || resting.median <= 0 || duration.median <= 0) {
    return { score: null, inputs: { rhr, hrv, sleep }, components: null, baseline: null, reason: "Valid readings and at least seven daily observations of resting heart rate, HRV and sleep are needed." };
  }
  // A simple personal-trend index, not a medical or exercise-safety judgement.
  // At baseline each component is 100. RHR +20% or HRV -40% reaches zero;
  // sleep is the fraction of usual duration. Equal weights, clamped to 0–100.
  const components = {
    rhr: clamp(100 - 500 * (rhr / resting.median - 1)),
    hrv: clamp(100 + 250 * (hrv / variability.median - 1)),
    sleep: clamp(100 * sleep / duration.median),
  };
  return { score: Math.round((components.rhr + components.hrv + components.sleep) / 3), inputs: { rhr, hrv, sleep }, components,
    baseline: { rhr: resting.median, hrv: variability.median, sleep: duration.median, days: { rhr: resting.n, hrv: variability.n, sleep: duration.n } },
    reason: "Equal-weight personal trends in resting heart rate, HRV and sleep." };
}
export function recoveryScore(rhr: number | null, hrv: number | null, sleep: number | null, baseline: BaselineSet): number | null {
  return recoveryExplanation(rhr, hrv, sleep, baseline).score;
}
