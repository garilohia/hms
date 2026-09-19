import { describe, expect, it } from "vitest";
import { dailySummary } from "../src/lib/analytics/daily";
import { summarySchema } from "../src/lib/patient/model";
import { reconcileSummaryDrain, todayHistoryRows, todayStatusMessage, type SummaryDrainStatus } from "../src/lib/patient/today-recovery";

function row(day: string, rhr: number | null, computedAt: string) {
  return summarySchema.parse({ ...dailySummary([], { day, timezone: "UTC" }), rhr, computed_at: computedAt, recovery_evidence: {} });
}

describe("Today recovery presentation", () => {
  const previous = row("2026-09-19", 60, "2026-09-19T10:00:00Z");
  const latest = row("2026-09-19", 72, "2026-09-19T10:01:00Z");

  it("does not show cached figures beside a newer live summary after a history failure", () => {
    expect(todayHistoryRows({ key: "old", rows: [previous] }, "new", latest, true)).toEqual([latest]);
  });

  it("does not restore a cleared metric from the older history", () => {
    const cleared = { ...latest, rhr: null, sleep_duration_min: null };
    expect(todayHistoryRows({ key: "old", rows: [previous] }, "new", cleared, true)).toEqual([cleared]);
  });

  it("restores chart history only when the requested summary version succeeds", () => {
    const rows = [previous, latest];
    expect(todayHistoryRows({ key: "current", rows }, "current", latest, true)).toBe(rows);
  });

  it("uses the live summary while the initial history request is recovering", () => {
    expect(todayHistoryRows(null, "current", latest, true)).toEqual([latest]);
    expect(todayHistoryRows(null, "current", undefined, true)).toEqual([]);
  });

  it("cannot carry a previous subject's cached rows into a new request or revoked scope", () => {
    const history = { key: "previous-subject-and-date", rows: [previous] };
    expect(todayHistoryRows(history, "new-subject-and-date", undefined, true)).toEqual([]);
    expect(todayHistoryRows(history, history.key, latest, false)).toEqual([]);
  });

  it.each(["Your readings are saved. Refresh later to retry the summary.", "Updating your summary…"])("clears only the summary drain status after live pending_jobs reaches zero: %s", message => {
    const recovered = reconcileSummaryDrain({ message, busy: true, recovered: false }, 0);
    expect(recovered).toEqual({ message: "", busy: false, recovered: true });
    expect(todayStatusMessage(recovered, "Acknowledgement could not be saved.")).toBe("Acknowledgement could not be saved.");
    expect(todayStatusMessage(recovered, "")).toBe("");
    expect(reconcileSummaryDrain(recovered, 2)).toBe(recovered);
  });

  it("does not infer recovery from missing or still-pending queue counts", () => {
    const status: SummaryDrainStatus = { message: "Updating your summary…", busy: true, recovered: false };
    expect(reconcileSummaryDrain(status, undefined)).toBe(status);
    expect(reconcileSummaryDrain(status, 1)).toBe(status);
    expect(todayStatusMessage(status, "")).toBe(status.message);
  });
});
