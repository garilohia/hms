import type { Summary } from "./model";

export type TodayHistory = { key: string; rows: Summary[] };

/** A previous profile, date range or summary version must not supply today's figures. */
export function todayHistoryRows(history: TodayHistory | null, key: string, summary: Summary | undefined, canReadHistory: boolean) {
  if (!canReadHistory) return [];
  if (history?.key === key) return history.rows;
  return summary ? [summary] : [];
}

export type SummaryDrainStatus = { message: string; busy: boolean; recovered: boolean };

/** Recovery is sticky for this drain attempt; later work cannot resurrect its old failure. */
export function reconcileSummaryDrain(status: SummaryDrainStatus, pendingJobs: number | undefined): SummaryDrainStatus {
  return pendingJobs === 0 && !status.recovered ? { message: "", busy: false, recovered: true } : status;
}

export function todayStatusMessage(status: SummaryDrainStatus, acknowledgementError: string) {
  return acknowledgementError || (status.recovered ? "" : status.message);
}
