import { z } from "zod";
import { integrationProvider } from "./model";

export const syncCollection = z.enum([
  "steps", "active-energy-burned", "daily-vo2-max", "heart-rate", "daily-resting-heart-rate",
  "daily-heart-rate-variability", "daily-oxygen-saturation", "daily-respiratory-rate",
  "daily-sleep-temperature-derivations", "weight", "sleep", "recovery", "cycle", "activity/sleep",
]);
export const syncCheckpoint = z.object({
  version: z.literal(1),
  provider: integrationProvider,
  window: z.object({ start: z.iso.datetime(), end: z.iso.datetime(), firstDay: z.iso.date(), nextDay: z.iso.date() }).strict(),
  collections: z.array(syncCollection).max(11),
  collectionIndex: z.number().int().min(0).max(11),
  nextToken: z.string().max(16384),
}).strict().refine(value => value.collectionIndex <= value.collections.length && Date.parse(value.window.start) < Date.parse(value.window.end), "Invalid provider checkpoint.");

export type SyncCheckpoint = z.infer<typeof syncCheckpoint>;
export type SyncCollection = z.infer<typeof syncCollection>;
