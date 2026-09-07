import { finite, mean, median } from "./statistics";
import { addDays, daysBetween, validDay } from "./time";
import type { CyclePhase, DayValue, PeriodLog } from "./types";

export const CYCLE_DISCLAIMER = "Estimate for planning training and energy. Not a measure of fertility or contraceptive safety.";
export function inferCyclePhase(skinTempSeries: readonly DayValue[], rhrSeries: readonly DayValue[], hrvSeries: readonly DayValue[], userLoggedPeriods: readonly PeriodLog[]): CyclePhase[] {
  const days = [...new Set([...skinTempSeries, ...rhrSeries, ...hrvSeries].map(r => r.day).filter(validDay))].sort();
  const logs = userLoggedPeriods.filter(p => validDay(p.start) && (!p.end || (validDay(p.end) && p.end >= p.start))).slice().sort((a, b) => a.start.localeCompare(b.start));
  const temps = new Map(skinTempSeries.filter(r => validDay(r.day) && finite(r.value)).map(r => [r.day, r.value!]));
  const resting = new Map(rhrSeries.filter(r => validDay(r.day) && finite(r.value)).map(r => [r.day, r.value!]));
  const shifts = new Map<string, string | null>();
  for (const log of logs) {
    const nextPeriod = logs.find(p => p.start > log.start)?.start;
    const early = (series: Map<string, number>) => [...series].filter(([d]) => d >= addDays(log.start, 5) && d < addDays(log.start, 13)).map(([, v]) => v);
    const tempBaseline = median(early(temps)), rhrBaseline = median(early(resting));
    let shift: string | null = null;
    if (finite(tempBaseline) && finite(rhrBaseline) && early(temps).length >= 3 && early(resting).length >= 3) {
      for (const day of days.filter(d => d >= addDays(log.start, 13) && d <= addDays(log.start, 40) && (!nextPeriod || d < nextPeriod))) {
        const window = [day, addDays(day, 1), addDays(day, 2)];
        if (nextPeriod && window[2] >= nextPeriod) continue;
        const temperatures = window.map(d => temps.get(d));
        const rates = window.map(d => resting.get(d));
        if (temperatures.every(finite) && rates.every(finite) && temperatures.every(t => t >= tempBaseline + .3 - 1e-9) && mean(rates)! > rhrBaseline) { shift = day; break; }
      }
    }
    shifts.set(log.start, shift);
  }
  return days.map(day => {
    const period = logs.filter(p => p.start <= day).at(-1);
    if (!period || daysBetween(period.start, day) > 45) return { day, phase: "unknown", confidence: "low", is_inferred: true, prompt: "Log a period start to anchor an estimate." };
    const periodEnd = period.end || addDays(period.start, 4);
    if (day <= periodEnd) return { day, phase: "menstrual", confidence: period.end ? "high" : "medium", is_inferred: !period.end && day !== period.start };
    const shift = shifts.get(period.start);
    if (shift && day >= shift) return { day, phase: "luteal", confidence: "medium", is_inferred: true };
    if (shift && day === addDays(shift, -1)) return { day, phase: "ovulatory", confidence: "low", is_inferred: true };
    // Do not predict an indefinitely long follicular phase from an old anchor.
    if (daysBetween(period.start, day) >= 20 && !shift) return { day, phase: "unknown", confidence: "low", is_inferred: true, prompt: "More consistent temperature and resting heart rate readings are needed." };
    return { day, phase: "follicular", confidence: "low", is_inferred: true };
  });
}
