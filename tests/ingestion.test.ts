import { BlobReader, BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normaliseApple, appleTimestamp } from "@/src/lib/ingestion/apple-normalise";
import { CsvParser, CSV_TEMPLATE, HealthCsvParser, UnsupportedCsvFormatError } from "@/src/lib/ingestion/csv";
import { FileAdapter } from "@/src/lib/ingestion/files";
import { boundedJson, httpTransport } from "@/src/lib/ingestion/http";
import { batchInput, type DataSource, type IngestionTransport, type NormalisedMetric } from "@/src/lib/ingestion/model";
import { SimulatorAdapter, sampleMetrics } from "@/src/lib/ingestion/simulator";
import { metricType } from "@/src/db/schema";
import { metricTypes } from "@/src/lib/ingestion/model";

const userId = "bcd5d3f3-924a-432c-95b0-24f30f19c2b8";
const source: DataSource = { id: userId, userId, provider: "generic_csv", key: "test" };
function memoryTransport() {
  const rows = new Map<string, NormalisedMetric>();
  let inFlight = 0, maxInFlight = 0;
  const transport: IngestionTransport = {
    async connect() { return source; },
    async persist(_source, batch) {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      expect(batch.length).toBeLessThanOrEqual(1000);
      let inserted = 0;
      await Promise.resolve();
      for (const row of batch) {
        const key = row.metric_type + row.recorded_at + row.device;
        if (!rows.has(key)) { rows.set(key, row); inserted++; }
      }
      inFlight--;
      return { inserted, skipped: batch.length - inserted };
    },
  };
  return { transport, rows, maxInFlight: () => maxInFlight };
}
const apple = { type: "HKQuantityTypeIdentifierHeartRate", value: "71", unit: "count/min", startDate: "2026-09-01 12:00:00 +0530", endDate: "2026-09-01 12:01:00 +0530", sourceName: "Sample watch" };
async function xmlZip(text: string, filename = "apple_health_export/export.xml") {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add(filename, new TextReader(text));
  return writer.close();
}
describe("normalisation and bounded import", () => {
  it("keeps the worker/API metric vocabulary aligned with the database", () => {
    expect(metricType.enumValues).toEqual([...metricTypes]);
  });
  it("keeps timestamps absolute across offsets and rejects invalid calendar dates", () => {
    expect(appleTimestamp(apple.startDate)).toBe("2026-09-01T06:30:00.000Z");
    expect(appleTimestamp("2026-02-30 00:00:00 +0000")).toBeNull();
    expect(appleTimestamp("2026-09-01 00:00:00")).toBeNull();
  });
  it("maps known quantities and units without labelling SDNN as RMSSD", () => {
    expect(normaliseApple(apple)[0]).toMatchObject({ metric_type: "heart_rate", value: 71, unit: "bpm", duration_s: 60 });
    expect(normaliseApple({ ...apple, type: "HKQuantityTypeIdentifierOxygenSaturation", value: "0.97", unit: "%" })[0].value).toBe(97);
    expect(normaliseApple({ ...apple, type: "HKQuantityTypeIdentifierBodyMass", value: "100", unit: "lb" })[0].value).toBeCloseTo(45.359237);
    expect(normaliseApple({ ...apple, type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", unit: "ms" })).toEqual([]);
    expect(normaliseApple({ ...apple, unit: "unknown" })).toEqual([]);
  });
  it("maps sleep categories to stable values and rejects backwards intervals", () => {
    expect(normaliseApple({ ...apple, type: "HKCategoryTypeIdentifierSleepAnalysis", value: "HKCategoryValueSleepAnalysisAsleepREM" })[0]).toMatchObject({ value: 4, unit: "stage" });
    expect(normaliseApple({ ...apple, endDate: "2026-09-01 10:00:00 +0530" })).toEqual([]);
  });
  it("ignores changing HKDevice memory addresses when identifying a device", () => {
    const a = normaliseApple({ ...apple, device: "<HKDevice: 0x123, name: Watch, model: Watch, hardware: Watch7>" });
    const b = normaliseApple({ ...apple, device: "<HKDevice: 0x987, name: Watch, model: Watch, hardware: Watch7>" });
    expect(a[0].device).toBe(b[0].device);
    expect(normaliseApple({ ...apple, sourceName: "x".repeat(201) })).toEqual([]);
  });
  it("handles CSV quotes, CRLF and chunk boundaries one character at a time", () => {
    const rows: string[][] = [];
    const parser = new CsvParser(row => rows.push(row));
    for (const char of 'timestamp,metric_type,value,unit\r\n"2026-09-01T00:00:00Z",steps,12,"count"\r\n') parser.write(char);
    parser.close();
    expect(rows).toEqual([["2026-09-01T00:00:00Z", "steps", "12", "count"]]);
  });
  it("maps Google Fit daily-metrics CSV columns in the profile timezone", () => {
    const metrics: NormalisedMetric[] = [];
    const parser = new HealthCsvParser(rows => metrics.push(...rows), "Asia/Kolkata");
    const csv = 'Date,Calories (kcal),Average heart rate (bpm),Step count,Average weight (kg),Distance (m)\r\n2026-09-01,1900.5,72,"8,123",70.5,1000\r\n';
    for (const char of csv) parser.write(char);
    parser.close();
    expect(metrics.map(metric => [metric.metric_type, metric.value, metric.unit])).toEqual([
      ["steps", 8123, "count"], ["total_calories", 1900.5, "kcal"], ["heart_rate", 72, "bpm"], ["weight_kg", 70.5, "kg"],
    ]);
    expect(new Set(metrics.map(metric => metric.recorded_at))).toEqual(new Set(["2026-08-31T18:30:00.000Z"]));
    expect(new Set(metrics.map(metric => metric.device))).toEqual(new Set(["Google Fit export"]));
  });
  it("uses absolute Google Fit intervals and rejects unrelated CSV headers", () => {
    const metrics: NormalisedMetric[] = [];
    const parser = new HealthCsvParser(rows => metrics.push(...rows), "Asia/Kolkata");
    parser.write("Start time,End time,Step count\n2026-09-01T06:00:00+05:30,2026-09-01T07:00:00+05:30,1000\n"); parser.close();
    expect(metrics[0]).toMatchObject({ recorded_at: "2026-09-01T00:30:00.000Z", duration_s: 3600, metric_type: "steps", value: 1000 });
    const unrelated = new HealthCsvParser(() => {});
    expect(() => unrelated.write("Name,Email\n")).toThrow(UnsupportedCsvFormatError);
  });
  it("bounds CSV fields and rejects broken quotes and headers", () => {
    expect(() => new CsvParser(() => {}).write("x".repeat(2049))).toThrow("too long");
    const parser = new CsvParser(() => {}); parser.write('"unfinished');
    expect(() => parser.close()).toThrow("unfinished");
    expect(() => new CsvParser(() => {}).write("bad,header\n")).toThrow("header");
    const auto = new HealthCsvParser(() => {}); auto.write("timestamp,metric_type,value,unit\n");
    expect(() => auto.write("2026-09-01T00:00:00Z,steps,1,count,extra\n")).toThrow("exactly four columns");
    // HMS exports retain provenance columns. Never silently strip them and
    // reclassify exported simulator rows as real generic-CSV readings.
    expect(() => new CsvParser(() => {}).write("timestamp,metric_type,value,unit,provider,is_sample\n")).toThrow("exactly four columns");
  });
  it("round-trips CSV template and deduplicates re-imports through normalise", async () => {
    const sink = memoryTransport();
    const adapter = new FileAdapter("generic_csv", new Blob([CSV_TEMPLATE]), sink.transport);
    for (const expected of [3, 0]) {
      expect((await adapter.sync(source)).inserted).toBe(expected);
    }
    expect(sink.rows.size).toBe(3);
  });
  it("streams a real compressed XML ZIP with backpressure and skip counts", async () => {
    const sink = memoryTransport();
    const record = '<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" value="70" startDate="2026-09-01 00:00:00 +0000"/>';
    const file = await xmlZip('<?xml version="1.0"?><!DOCTYPE HealthData [<!ELEMENT HealthData ANY>]><HealthData>' + record.repeat(3100) + '<Record type="Unknown"/>' + '</HealthData>');
    let unsupported = 0;
    const adapter = new FileAdapter("apple_health_export", file, sink.transport, { onProgress: p => { unsupported = p.unsupported; } });
    expect(await adapter.sync(source)).toMatchObject({ inserted: 1, skipped: 3099 });
    expect(unsupported).toBe(1);
    expect(sink.maxInFlight()).toBe(1);
    // Prove the fixture is compressed and read through ZIP code, not a plain XML shortcut.
    expect(file.size).toBeLessThan(3100 * record.length);
    expect(new BlobReader(file)).toBeDefined();
  });
  it("rejects missing XML, malformed XML, entities and oversized XML tokens", async () => {
    const sink = memoryTransport();
    for (const body of ["<HealthData><Record></HealthData>", "<HealthData>&external;</HealthData>", '<HealthData><Record value="' + "x".repeat(300000) + '"/></HealthData>']) {
      await expect(new FileAdapter("apple_health_export", await xmlZip(body), sink.transport).sync(source)).rejects.toThrow();
    }
    await expect(new FileAdapter("apple_health_export", await xmlZip("x", "other.xml"), sink.transport).sync(source)).rejects.toThrow("No export.xml");
  });
  it("cancels before persistence and allows a fresh re-import", async () => {
    const sink = memoryTransport(); const controller = new AbortController(); controller.abort();
    await expect(new FileAdapter("generic_csv", new Blob([CSV_TEMPLATE]), sink.transport, { signal: controller.signal }).sync(source)).rejects.toThrow();
    expect(sink.rows.size).toBe(0);
    expect((await new FileAdapter("generic_csv", new Blob([CSV_TEMPLATE]), sink.transport).sync(source)).inserted).toBe(3);
  });
  it("rejects bad API metric units and excessive batch sizes", () => {
    const metric = normaliseApple(apple)[0];
    expect(batchInput.safeParse({ userId, sourceId: userId, metrics: [{ ...metric, unit: "kg" }] }).success).toBe(false);
    expect(batchInput.safeParse({ userId, sourceId: userId, metrics: Array(1001).fill(metric) }).success).toBe(false);
  });
  it("counts actual request bytes even with a false Content-Length", async () => {
    const request = new Request("https://example.invalid", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: JSON.stringify("x".repeat(20)) });
    await expect(boundedJson(request, 10)).rejects.toThrow("byte limit");
  });
});
describe("deterministic 90-day sample personas", () => {
  it.each(["a", "b", "c"] as const)("seeds persona %s through the adapter without duplicate growth", async persona => {
    const raw = [...sampleMetrics(persona, 42, "2026-09-08")];
    expect([...sampleMetrics(persona, 42, "2026-09-08")]).toEqual(raw);
    expect(new Set(raw.map(m => m.recorded_at.slice(0, 10))).size).toBe(90);
    const sink = memoryTransport(); const adapter = new SimulatorAdapter(sink.transport, persona, 42, "2026-09-08");
    expect((await adapter.sync(source)).inserted).toBe(raw.length);
    expect((await adapter.sync(source)).inserted).toBe(0);
    expect(sink.maxInFlight()).toBe(1);
  });
  it("includes anchored cycle samples and sustained low oxygen/temperature episodes", () => {
    expect([...sampleMetrics("b")].filter(m => m.metric_type === "menstrual_flow" && m.quality === "user_entered").length).toBeGreaterThan(10);
    const c = [...sampleMetrics("c")];
    expect(c.filter(m => m.metric_type === "spo2" && m.value < 90).length).toBe(12);
    expect(c.filter(m => m.metric_type === "skin_temperature" && m.value > 34.5).length).toBe(3);
  });
});

describe("idempotent HTTP retry policy", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  it("retries a temporary server failure after waiting", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(Response.json({ id: userId }));
    const task = httpTransport().connect(userId, "generic_csv", "CSV");
    await vi.runAllTimersAsync();
    expect((await task).id).toBe(userId); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("retries a network error with the same payload", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Network failure"))
      .mockResolvedValueOnce(Response.json({ id: userId }));
    const task = httpTransport().connect(userId, "generic_csv", "CSV");
    await vi.runAllTimersAsync(); await task;
    expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
  });
  it("does not retry a revoked consent or try to bypass a long rate limit", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error: "Consent revoked" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "Rate limited" }, { status: 429, headers: { "Retry-After": "3600" } }));
    await expect(httpTransport().connect(userId, "generic_csv", "CSV")).rejects.toThrow("Consent revoked");
    await expect(httpTransport().connect(userId, "generic_csv", "CSV")).rejects.toThrow("later");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels while waiting for retry without sending another request", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "busy" }, { status: 503 }));
    const task = httpTransport(controller.signal).connect(userId, "generic_csv", "CSV");
    const rejected = expect(task).rejects.toThrow("Cancelled");
    await vi.advanceTimersByTimeAsync(1); controller.abort(new Error("Cancelled"));
    await rejected; expect(fetch).toHaveBeenCalledTimes(1);
  });
});
