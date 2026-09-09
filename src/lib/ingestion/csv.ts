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

type GoogleColumn = { index: number; metric_type: MetricType; unit: string };
const googleColumns: { names: string[]; metric_type: MetricType; unit: string }[] = [
  { names: ["step count", "steps"], metric_type: "steps", unit: "count" },
  { names: ["calories (kcal)"], metric_type: "total_calories", unit: "kcal" },
  { names: ["average heart rate (bpm)"], metric_type: "heart_rate", unit: "bpm" },
  { names: ["average weight (kg)"], metric_type: "weight_kg", unit: "kg" },
];
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

/** Auto-detects the HMS four-column format or Google Fit daily-metrics CSVs. */
export class HealthCsvParser {
  private mode: "hms" | "google" | undefined;
  private google: { timestamp: number; end: number; columns: GoogleColumn[] } | undefined;
  private parser: CsvRowsParser;
  constructor(private accept: (metrics: NormalisedMetric[]) => void, private timezone = "UTC") {
    this.parser = new CsvRowsParser(header => this.header(header), row => this.row(row), 128);
  }
  private header(header: string[]) {
    if (header.join(",") === "timestamp,metric_type,value,unit") { this.mode = "hms"; return; }
    const names = header.map(value => value.toLowerCase());
    const timestamp = names.indexOf("start time") >= 0 ? names.indexOf("start time") : names.indexOf("date");
    const columns = googleColumns.flatMap(column => {
      const index = column.names.map(name => names.indexOf(name)).find(candidate => candidate >= 0);
      return index === undefined ? [] : [{ index, metric_type: column.metric_type, unit: column.unit }];
    });
    if (timestamp < 0 || !columns.length) throw new UnsupportedCsvFormatError("Unsupported CSV header. Choose HMS CSVs or Google Fit Daily activity metrics CSVs.");
    this.mode = "google"; this.google = { timestamp, end: names.indexOf("end time"), columns };
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
      return canonicalMetric({ metric_type: column.metric_type, value: Number(text), unit: column.unit, recorded_at, duration_s,
        quality: "raw", external_id: null, device: "Google Fit export" });
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
