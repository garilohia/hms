import { z } from "zod";
import { metricTypes, normalisedMetric } from "../ingestion/model";

export const MOBILE_PROTOCOL_VERSION = 1;
export const nativePlatforms = ["ios_healthkit", "android_health_connect"] as const;

export const mobileSourceInput = z.object({
  userId: z.uuid(),
  platform: z.enum(nativePlatforms),
  installationId: z.string().trim().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  label: z.string().trim().min(1).max(120),
  metrics: z.array(z.enum(metricTypes)).min(1).max(metricTypes.length).transform(values => [...new Set(values)]),
  expectedCadenceSeconds: z.number().int().min(60).max(86_400),
}).strict();

export const mobileBatchInput = z.object({
  protocolVersion: z.literal(MOBILE_PROTOCOL_VERSION),
  userId: z.uuid(),
  sourceId: z.uuid(),
  batchId: z.uuid(),
  metrics: z.array(normalisedMetric).min(1).max(1000),
}).strict();

export type MobileSourceInput = z.infer<typeof mobileSourceInput>;
export type MobileBatchInput = z.infer<typeof mobileBatchInput>;
