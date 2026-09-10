import { describe, expect, it } from "vitest";
import { MOBILE_PROTOCOL_VERSION, mobileBatchInput, mobileSourceInput } from "../src/lib/mobile/protocol";

const source = { userId: "00000000-0000-4000-a000-000000000001", platform: "ios_healthkit", installationId: "ios:00000000-0000-4000-a000-000000000002", label: "My iPhone", metrics: ["heart_rate", "heart_rate", "spo2"], expectedCadenceSeconds: 60 };
const metric = { metric_type: "heart_rate", value: 70, unit: "bpm", recorded_at: "2026-09-10T12:00:00Z", duration_s: 60, quality: "raw", external_id: "sample:1" };

describe("native ingestion protocol", () => {
  it("normalises capabilities and accepts bounded canonical batches", () => {
    expect(mobileSourceInput.parse(source).metrics).toEqual(["heart_rate", "spo2"]);
    expect(mobileBatchInput.parse({ protocolVersion: MOBILE_PROTOCOL_VERSION, userId: source.userId, sourceId: "00000000-0000-4000-a000-000000000003", batchId: "00000000-0000-4000-a000-000000000004", metrics: [metric] }).metrics).toHaveLength(1);
  });
  it("rejects unstable identifiers, unsupported cadence and noncanonical units", () => {
    expect(mobileSourceInput.safeParse({ ...source, installationId: "short" }).success).toBe(false);
    expect(mobileSourceInput.safeParse({ ...source, expectedCadenceSeconds: 1 }).success).toBe(false);
    expect(mobileBatchInput.safeParse({ protocolVersion: MOBILE_PROTOCOL_VERSION, userId: source.userId, sourceId: "00000000-0000-4000-a000-000000000003", batchId: "00000000-0000-4000-a000-000000000004", metrics: [{ ...metric, unit: "Hz" }] }).success).toBe(false);
  });
});
