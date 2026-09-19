import { z } from "zod";
import { integrationProvider } from "./model";

export const syncCollection = z.enum([
  "steps", "active-energy-burned", "daily-vo2-max", "heart-rate", "daily-resting-heart-rate",
  "daily-heart-rate-variability", "daily-oxygen-saturation", "daily-respiratory-rate",
  "daily-sleep-temperature-derivations", "weight", "sleep", "recovery", "cycle", "activity/sleep",
]);
const windowSchema = z.object({ start: z.iso.datetime(), end: z.iso.datetime(), firstDay: z.iso.date(), nextDay: z.iso.date() }).strict();
const legacyCheckpoint = z.object({
  version: z.literal(1),
  provider: integrationProvider,
  window: windowSchema,
  collections: z.array(syncCollection).max(11),
  collectionIndex: z.number().int().min(0).max(11),
  nextToken: z.string().max(16384),
}).strict().refine(value => value.collectionIndex <= value.collections.length && (value.collectionIndex < value.collections.length || !value.nextToken) && Date.parse(value.window.start) < Date.parse(value.window.end), "Invalid provider checkpoint.");

const fairCheckpoint = z.object({
  version: z.literal(2),
  provider: integrationProvider,
  window: windowSchema,
  collections: z.array(syncCollection).max(11),
  cursors: z.array(z.object({ nextToken: z.string().max(16384), complete: z.boolean() }).strict()).max(11),
  reconciliationIndex: z.number().int().min(0).max(10),
  probeIndex: z.number().int().min(0).max(10),
  nextLane: z.enum(["reconciliation", "head"]),
}).strict().refine(value =>
  Date.parse(value.window.start) < Date.parse(value.window.end)
  && new Set(value.collections).size === value.collections.length
  && value.collections.length === value.cursors.length
  && value.reconciliationIndex < Math.max(1, value.collections.length)
  && value.probeIndex < Math.max(1, value.collections.length)
  && value.cursors.every(cursor => !cursor.complete || !cursor.nextToken), "Invalid provider checkpoint.");

// Keep the old shape readable: deployed connections may be partway through a
// frozen v1 page. Conversion is CAS-persisted before requesting any new page.
export const syncCheckpoint = z.union([legacyCheckpoint, fairCheckpoint]);

export type SyncCheckpoint = z.infer<typeof syncCheckpoint>;
export type FairSyncCheckpoint = z.infer<typeof fairCheckpoint>;
export type SyncCollection = z.infer<typeof syncCollection>;

export function fairSyncCheckpoint(value: SyncCheckpoint): FairSyncCheckpoint {
  if (value.version === 2) return value;
  return fairCheckpoint.parse({
    version: 2, provider: value.provider, window: value.window, collections: value.collections,
    cursors: value.collections.map((_, index) => ({ complete: index < value.collectionIndex, nextToken: index === value.collectionIndex ? value.nextToken : "" })),
    reconciliationIndex: value.collectionIndex % Math.max(1, value.collections.length),
    probeIndex: 0, nextLane: "reconciliation",
  });
}

export function reconciliationComplete(value: SyncCheckpoint): boolean {
  return value.version === 1 ? value.collectionIndex === value.collections.length && !value.nextToken : value.cursors.every(cursor => cursor.complete);
}

export type SyncVisit = { lane: "head" | "reconciliation"; index: number };

export function nextSyncVisit(value: FairSyncCheckpoint, now: number): SyncVisit | null {
  if (reconciliationComplete(value)) return null;
  // Head probes are bounded, best-effort acceleration, never an alternative to
  // draining every frozen reconciliation token. Avoid duplicating a new sweep.
  const canProbe = value.provider === "google_health" && now - Date.parse(value.window.end) >= 60_000 && value.cursors.some(cursor => cursor.nextToken);
  if (canProbe && value.nextLane === "head") return { lane: "head", index: value.probeIndex };
  for (let offset = 0; offset < value.collections.length; offset++) {
    const index = (value.reconciliationIndex + offset) % value.collections.length;
    if (!value.cursors[index].complete) return { lane: "reconciliation", index };
  }
  return null;
}

export function advanceSyncVisit(value: FairSyncCheckpoint, visit: SyncVisit, nextToken: string): FairSyncCheckpoint {
  if (visit.lane === "head") return { ...value, probeIndex: (visit.index + 1) % value.collections.length, nextLane: "reconciliation" };
  return fairCheckpoint.parse({ ...value,
    cursors: value.cursors.map((cursor, index) => index === visit.index ? { nextToken, complete: !nextToken } : cursor),
    reconciliationIndex: (visit.index + 1) % value.collections.length, nextLane: "head",
  });
}
