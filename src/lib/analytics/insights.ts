import { finite, mean } from "./statistics";
import { addDays, validDay } from "./time";
import { INSIGHT_FOOTER, type BaselineSet, type CyclePhase, type DailySummary, type Insight } from "./types";

export function generateInsights(dailySummaries: readonly DailySummary[], baselines: BaselineSet, cyclePhases: readonly CyclePhase[]): Insight[] {
  const daily = [...new Map(dailySummaries.filter(d => validDay(d.day)).map(d => [d.day, d])).values()].sort((a, b) => a.day.localeCompare(b.day));
  const latest = daily.at(-1);
  if (!latest) return [];
  const byDay = new Map(daily.map(d => [d.day, d])), phases = new Map(cyclePhases.map(p => [p.day, p.phase]));
  const recent = daily.filter(d => d.day >= addDays(latest.day, -6));
  const tail = (n: number) => Array.from({ length: n }, (_, i) => byDay.get(addDays(latest.day, i - n + 1)));
  const average = (field: keyof DailySummary) => {
    const values = recent.map(d => d[field]).filter(finite);
    return values.length >= 5 ? mean(values) : null;
  };
  const baseline = (type: keyof BaselineSet) => { const b = baselines[type]; return b && b.n >= 7 && finite(b.median) ? b.median : null; };
  const result: Insight[] = [];
  function add(category: Insight["category"], title: string, body: string, confidence: Insight["confidence"], evidence: Record<string, unknown>) {
    result.push({ category, title, body: body + "\n\n" + INSIGHT_FOOTER, confidence, evidence: { through_day: latest!.day, ...evidence } });
  }
  const sleep = average("sleep_duration_min"), usualSleep = baseline("sleep_duration");
  if (finite(sleep) && finite(usualSleep) && sleep < usualSleep - 45) add("sleep", "You've slept less than usual this week.", "Your recorded sleep is below your personal pattern. Consider discussing persistent changes with your doctor.", "medium", { window_days: 7, sleep_minutes: sleep, baseline_minutes: usualSleep });
  const usualHrv = baseline("hrv_rmssd"), usualRhr = baseline("resting_heart_rate");
  const strained = tail(3).every(d => d && finite(d.hrv_avg) && finite(d.rhr) && finite(usualHrv) && finite(usualRhr) && d.hrv_avg < usualHrv && d.rhr > usualRhr);
  if (strained) add("stress", "Your body shows signs of strain.", "HRV has been below your usual level and resting heart rate above it for three consecutive days. These patterns can have many explanations.", "medium", { window_days: 3, baseline_hrv: usualHrv, baseline_rhr: usualRhr });
  const lowNights = recent.filter(d => finite(d.night_spo2_min) && d.night_spo2_min < 92);
  if (lowNights.length >= 2) add("recovery", "Your night-time oxygen readings need a review.", "Readings fell below 92% on at least two nights this week. A doctor can review these consumer-device readings in context.", "medium", { severity: "attention", window_days: 7, nights: lowNights.map(d => ({ day: d.day, minimum: d.night_spo2_min })) });
  if (tail(2).every(d => d && finite(d.skin_temp_deviation) && d.skin_temp_deviation > .5 && phases.get(d.day) !== "luteal")) {
    add("recovery", "You may be running a temperature.", "Skin temperature has been above your personal pattern for two consecutive days outside an estimated luteal phase. Wearable skin readings are not a clinical temperature measurement.", "low", { window_days: 2, metric: "skin_temperature", deviation_c: latest.skin_temp_deviation });
  }
  if (tail(3).every(d => d && finite(d.readiness_score) && d.readiness_score < 50 && finite(d.hrv_avg) && finite(usualHrv) && d.hrv_avg < usualHrv && finite(d.skin_temp_deviation) && d.skin_temp_deviation < 0)) {
    add("nutrition_ask_doctor", "Worth asking your doctor about iron and thyroid.", "Your recent readiness, HRV and skin-temperature patterns are not specific to any condition. Whether tests are useful is worth asking your doctor about.", "low", { window_days: 3, proxy: "low_readiness_low_hrv_low_skin_temperature" });
  }
  const stress = average("stress_avg"), usualStress = baseline("stress_score");
  if (finite(sleep) && finite(usualSleep) && sleep < usualSleep - 45 && finite(stress) && finite(usualStress) && stress > usualStress * 1.25) {
    add("nutrition_ask_doctor", "Worth asking your doctor about magnesium.", "Recorded sleep has been lower and stress readings higher than usual. Whether magnesium is relevant is worth asking your doctor about; these readings do not show a deficiency.", "low", { window_days: 7, sleep_minutes: sleep, stress_average: stress });
  }
  const phase = phases.get(latest.day), previousPhase = phases.get(addDays(latest.day, -1));
  if (previousPhase && previousPhase !== "unknown" && phase !== previousPhase && (phase === "luteal" || phase === "follicular")) {
    add("cycle", phase === "luteal" ? "Your estimated luteal phase has started." : "Your estimated follicular phase has started.",
      phase === "luteal" ? "Energy may dip over the next ~10 days; heavier training earlier in your cycle usually feels better. This is an estimate for planning training and energy, not fertility or contraception." : "Energy may improve over the next few days; heavier training earlier in your cycle usually feels better. This is an estimate for planning training and energy, not fertility or contraception.",
      "low", { phase, previous_phase: previousPhase, estimate_only: true });
  }
  const steps = average("steps"), usualSteps = baseline("steps");
  if (finite(steps) && finite(usualSteps) && usualSteps > 0 && steps < usualSteps * .5) add("activity", "You've moved less than usual this week.", "Your recorded steps are below half your personal daily pattern. If appropriate for you, a small amount of comfortable movement may fit your day.", "medium", { window_days: 7, average_steps: steps, baseline_steps: usualSteps });
  return result;
}
