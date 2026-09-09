import { z } from "zod";
import { dayBounds, validDay } from "../analytics/time";
import { canonicalMetric } from "./model";
import type { MetricType, NormalisedMetric } from "./model";

export const CSV_TEMPLATE = "timestamp,metric_type,value,unit\n2026-09-01T06:00:00+05:30,resting_heart_rate,62,bpm\n2026-09-01T06:00:00+05:30,spo2,97,%\n2026-09-01T06:00:00+05:30,weight_kg,72,kg\n";
export function normaliseCsv(raw: unknown) {
  const row = z.array(z.string()).length(4).safeParse(raw);
  if (!row.success) return [];
  const [recorded_at, metric_type, text, unit] = row.data.map(v => v.trim());
  return canonicalMetric({ recorded_at, metric_type, value: text === "" ? NaN : Number(text), unit, quality: "raw" });
}

export class UnsupportedCsvFormatError extends Error {}

type GoogleColumn = { index: number; metric_type: MetricType; unit: string; scale?: number };
const googleColumns: { names: string[]; metric_type: MetricType; unit: string }[] = [
  { names: ["step count", "steps"], metric_type: "steps", unit: "count" },
  { names: ["calories (kcal)"], metric_type: "total_calories", unit: "kcal" },
  { names: ["average heart rate (bpm)"], metric_type: "heart_rate", unit: "bpm" },
  { names: ["average weight (kg)"], metric_type: "weight_kg", unit: "kg" },
];

type GoogleHealthSchema = { filename: RegExp; column: string; metric_type: MetricType; unit: string; scale?: number };
const googleHealthSchemas: GoogleHealthSchema[] = [
  { filename: /^daily_resting_heart_rate\.csv$/i, column: "beats per minute", metric_type: "resting_heart_rate", unit: "bpm" },
  { filename: /^heart_rate_\d{4}-\d{2}(?:-\d{2})?\.csv$/i, column: "beats per minute", metric_type: "heart_rate", unit: "bpm" },
  { filename: /^steps_\d{4}-\d{2}(?:-\d{2})?\.csv$/i, column: "steps", metric_type: "steps", unit: "count" },
  { filename: /^active_energy_burned_\d{4}-\d{2}(?:-\d{2})?\.csv$/i, column: "kilocalories", metric_type: "active_calories", unit: "kcal" },
  { filename: /^calories_\d{4}-\d{2}(?:-\d{2})?\.csv$/i, column: "calories", metric_type: "total_calories", unit: "kcal" },
  { filename: /^heart_rate_variability_\d{4}-\d{2}(?:-\d{2})?\.csv$/i, column: "root mean square of successive differences milliseconds", metric_type: "hrv_rmssd", unit: "ms" },
  { filename: /^oxygen_saturation_\d{4}-\d{2}(?:-\d{2})?\.csv$/i, column: "oxygen saturation percentage", metric_type: "spo2", unit: "%" },
  { filename: /^daily_respiratory_rate\.csv$/i, column: "breaths per minute", metric_type: "respiratory_rate", unit: "breaths/min" },
  { filename: /^body_temperature_\d{4}-\d{2}(?:-\d{2})?\.csv$/i, column: "temperature celsius", metric_type: "skin_temperature", unit: "°C" },
  { filename: /^weight\.csv$/i, column: "weight grams", metric_type: "weight_kg", unit: "kg", scale: 0.001 },
];

function basename(path: string) { return path.replace(/\\/g, "/").split("/").pop() || path; }
function absoluteTimestamp(value: string, timezone: string): string | null {
  const trimmed = value.trim();
  if (validDay(trimmed)) return new Date(dayBounds(trimmed, timezone).start).toISOString();
  const canonical = trimmed.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ([+-]\d{2})(\d{2})$/, "$1T$2$3:$4");
  if (!z.iso.datetime({ offset: true }).safeParse(canonical).success) return null;
  const epoch = Date.parse(canonical);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

/** A bounded RFC-4180 row parser for vendor CSVs with variable columns. */
class CsvRowsParser {
  private field = "";
  private row: string[] = [];
  private quoted = false;
  private afterQuote = false;
  private skipLf = false;
  private header = false;
  constructor(private acceptHeader: (header: string[]) => void, private accept: (row: string[]) => void, private maxColumns: number) {}
  private finishField() {
    this.row.push(this.field); this.field = ""; this.afterQuote = false;
    if (this.row.length > this.maxColumns) throw new Error("CSV has too many columns.");
  }
  private finishRow() {
    this.finishField();
    if (!(this.row.length === 1 && !this.row[0].trim())) {
      if (!this.header) {
        this.row[0] = this.row[0].replace(/^\uFEFF/, "");
        this.acceptHeader(this.row.map(value => value.trim())); this.header = true;
      } else this.accept(this.row);
    }
    this.row = [];
  }
  write(text: string) {
    for (const char of text) {
      if (this.skipLf) { this.skipLf = false; if (char === "\n") continue; }
      if (this.quoted) {
        if (char === '"') { this.quoted = false; this.afterQuote = true; }
        else this.field += char;
      } else if (this.afterQuote && char === '"') { this.field += char; this.quoted = true; this.afterQuote = false; }
      else if (char === ",") this.finishField();
      else if (char === "\n" || char === "\r") { this.finishRow(); this.skipLf = char === "\r"; }
      else if (char === '"' && this.field === "" && !this.afterQuote) this.quoted = true;
      else {
        if (this.afterQuote || char === '"') throw new Error("CSV contains a malformed quoted field.");
        this.field += char;
      }
      if (this.field.length > 2048) throw new Error("CSV field is too long.");
    }
  }
  close() {
    if (this.quoted) throw new Error("CSV has an unfinished quoted field.");
    if (this.field || this.row.length || this.afterQuote) this.finishRow();
    if (!this.header) throw new UnsupportedCsvFormatError("CSV is empty.");
  }
}

/** Auto-detects HMS, legacy Google Fit, and Google Health Takeout CSVs. */
export class HealthCsvParser {
  private mode: "hms" | "google_fit" | "google_health" | undefined;
  private google: { timestamp: number; end: number; columns: GoogleColumn[]; device: string } | undefined;
  private parser: CsvRowsParser;
  constructor(private accept: (metrics: NormalisedMetric[]) => void, private timezone = "UTC", private filePath = "") {
    this.parser = new CsvRowsParser(header => this.header(header), row => this.row(row), 128);
  }
  private header(header: string[]) {
    if (header.join(",") === "timestamp,metric_type,value,unit") { this.mode = "hms"; return; }
    const names = header.map(value => value.toLowerCase());
    const googleHealth = googleHealthSchemas.find(schema => schema.filename.test(basename(this.filePath)) && names.includes(schema.column));
    if (googleHealth) {
      const timestamp = names.indexOf("timestamp"), index = names.indexOf(googleHealth.column);
      if (timestamp < 0) throw new UnsupportedCsvFormatError("Google Health CSV is missing its timestamp column.");
      this.mode = "google_health";
      this.google = { timestamp, end: -1, device: "Google Health export",
        columns: [{ index, metric_type: googleHealth.metric_type, unit: googleHealth.unit, scale: googleHealth.scale }] };
      return;
    }
    const timestamp = names.indexOf("start time") >= 0 ? names.indexOf("start time") : names.indexOf("date");
    const columns = googleColumns.flatMap(column => {
      const index = column.names.map(name => names.indexOf(name)).find(candidate => candidate >= 0);
      return index === undefined ? [] : [{ index, metric_type: column.metric_type, unit: column.unit }];
    });
    if (timestamp < 0 || !columns.length) throw new UnsupportedCsvFormatError("Unsupported health CSV header.");
    this.mode = "google_fit"; this.google = { timestamp, end: names.indexOf("end time"), columns, device: "Google Fit export" };
  }
  private row(row: string[]) {
    if (this.mode === "hms") {
      if (row.length !== 4) throw new Error("CSV must contain exactly four columns.");
      this.accept(normaliseCsv(row)); return;
    }
    const config = this.google;
    if (!config) throw new UnsupportedCsvFormatError("Unsupported CSV header.");
    const recorded_at = absoluteTimestamp(row[config.timestamp] || "", this.timezone);
    const ended_at = config.end >= 0 ? absoluteTimestamp(row[config.end] || "", this.timezone) : null;
    const seconds = recorded_at && ended_at ? Math.round((Date.parse(ended_at) - Date.parse(recorded_at)) / 1000) : null;
    const duration_s = seconds !== null && seconds >= 0 && seconds <= 604800 ? seconds : null;
    if (!recorded_at) { this.accept([]); return; }
    this.accept(config.columns.flatMap(column => {
      const text = (row[column.index] || "").trim().replace(/,/g, "");
      if (!text) return [];
      return canonicalMetric({ metric_type: column.metric_type, value: Number(text) * (column.scale ?? 1), unit: column.unit, recorded_at, duration_s,
        quality: "raw", external_id: null, device: config.device });
    }));
  }
  write(text: string) { this.parser.write(text); }
  close() { this.parser.close(); }
}

/** Incremental RFC-4180-style fields, including quotes and CRLF across chunks. */
export class CsvParser {
  private field = "";
  private row: string[] = [];
  private quoted = false;
  private afterQuote = false;
  private skipLf = false;
  private header = false;
  constructor(private accept: (row: string[]) => void) {}
  private finishField() { this.row.push(this.field); this.field = ""; this.afterQuote = false; if (this.row.length > 4) throw new Error("CSV must contain exactly four columns."); }
  private finishRow() {
    this.finishField();
    if (!(this.row.length === 1 && !this.row[0].trim())) {
      if (!this.header) {
        if (this.row.map(v => v.trim()).join(",") !== "timestamp,metric_type,value,unit") throw new Error("Expected CSV header: timestamp,metric_type,value,unit.");
        this.header = true;
      } else this.accept(this.row);
    }
    this.row = [];
  }
  write(text: string) {
    for (const char of text) {
      if (this.skipLf) { this.skipLf = false; if (char === "\n") continue; }
      if (this.quoted) {
        if (char === '"') { this.quoted = false; this.afterQuote = true; }
        else this.field += char;
      } else if (this.afterQuote && char === '"') { this.field += char; this.quoted = true; this.afterQuote = false; }
      else if (char === ",") this.finishField();
      else if (char === "\n" || char === "\r") { this.finishRow(); this.skipLf = char === "\r"; }
      else if (char === '"' && this.field === "" && !this.afterQuote) this.quoted = true;
      else {
        if (this.afterQuote || char === '"') throw new Error("CSV contains a malformed quoted field.");
        this.field += char;
      }
      if (this.field.length > 2048) throw new Error("CSV field is too long.");
    }
  }
  close() {
    if (this.quoted) throw new Error("CSV has an unfinished quoted field.");
    if (this.field || this.row.length || this.afterQuote) this.finishRow();
    if (!this.header) throw new Error("CSV is empty.");
  }
}
