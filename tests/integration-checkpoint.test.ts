import { describe, expect, it } from "vitest";
import { advanceSyncVisit, fairSyncCheckpoint, nextSyncVisit, reconciliationComplete, syncCheckpoint, type SyncCheckpoint } from "@/src/lib/integrations/checkpoint";

const legacy: SyncCheckpoint = { version: 1, provider: "google_health", window: { start: "2026-09-11T12:00:00.000Z", end: "2026-09-18T12:00:00.000Z", firstDay: "2026-09-11", nextDay: "2026-09-19" }, collections: ["heart-rate", "daily-oxygen-saturation", "sleep"], collectionIndex: 1, nextToken: "exact-token" };

describe("fair provider checkpoints", () => {
  it("converts v1 preserving completed collections, frozen boundaries and its exact continuation", () => {
    const converted = fairSyncCheckpoint(legacy);
    expect(converted.window).toEqual(legacy.window);
    expect(converted.cursors).toEqual([{ complete: true, nextToken: "" }, { complete: false, nextToken: "exact-token" }, { complete: false, nextToken: "" }]);
    expect(converted.reconciliationIndex).toBe(1);
    expect(syncCheckpoint.parse(JSON.parse(JSON.stringify(converted)))).toEqual(converted);
  });

  it("cannot discard an invalid continuation attached to an allegedly completed v1 sweep", () => {
    expect(syncCheckpoint.safeParse({ ...legacy, collectionIndex: 3 }).success).toBe(false);
  });

  it("keeps checkpoint arrays and tokens bounded and rejects ambiguous completed cursors", () => {
    const converted = fairSyncCheckpoint(legacy);
    expect(syncCheckpoint.safeParse({ ...converted, cursors: [] }).success).toBe(false);
    expect(syncCheckpoint.safeParse({ ...converted, reconciliationIndex: 3 }).success).toBe(false);
    expect(syncCheckpoint.safeParse({ ...converted, probeIndex: 3 }).success).toBe(false);
    expect(syncCheckpoint.safeParse({ ...converted, cursors: converted.cursors.map(cursor => ({ ...cursor, nextToken: "x".repeat(16385) })) }).success).toBe(false);
    expect(syncCheckpoint.safeParse({ ...converted, cursors: converted.cursors.map(cursor => ({ ...cursor, complete: true })) }).success).toBe(false);
  });

  it("alternates Google heads with reconciliation and rotates both lanes", () => {
    let current = fairSyncCheckpoint({ ...legacy, collectionIndex: 0 });
    const visits = [];
    for (let index = 0; index < 12; index++) {
      const visit = nextSyncVisit(current, Date.parse("2026-09-19T12:00:00Z"))!;
      visits.push(visit);
      current = advanceSyncVisit(current, visit, `next-${index}`);
    }
    expect(visits.slice(0, 6)).toEqual([
      { lane: "reconciliation", index: 0 }, { lane: "head", index: 0 },
      { lane: "reconciliation", index: 1 }, { lane: "head", index: 1 },
      { lane: "reconciliation", index: 2 }, { lane: "head", index: 2 },
    ]);
    expect(current.cursors.map(cursor => cursor.nextToken)).toEqual(["next-6", "next-8", "next-10"]);
    expect(reconciliationComplete(current)).toBe(false);
  });

  it("does not invent WHOOP head semantics and skips completed metrics fairly", () => {
    let current = fairSyncCheckpoint({ ...legacy, provider: "whoop", collections: ["recovery", "cycle", "activity/sleep"], collectionIndex: 0 });
    const visits = [];
    for (let index = 0; index < 5; index++) {
      const visit = nextSyncVisit(current, Date.parse("2026-09-19T12:00:00Z"))!;
      visits.push(visit);
      current = advanceSyncVisit(current, visit, visit.index === 1 ? "" : "next");
    }
    expect(visits).toEqual([0, 1, 2, 0, 2].map(index => ({ lane: "reconciliation", index })));
  });

  it("does not spend head requests on a new sweep and completes only after every cursor", () => {
    let current = fairSyncCheckpoint({ ...legacy, collectionIndex: 0 });
    for (let index = 0; index < 3; index++) {
      const visit = nextSyncVisit(current, Date.parse(legacy.window.end))!;
      expect(visit).toEqual({ lane: "reconciliation", index });
      current = advanceSyncVisit(current, visit, "");
    }
    expect(reconciliationComplete(current)).toBe(true);
    expect(nextSyncVisit(current, Date.parse("2026-09-19T12:00:00Z"))).toBeNull();
  });
});
