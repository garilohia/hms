import { z } from "zod";
import { canonicalMetric } from "./model";

export const CSV_TEMPLATE = "timestamp,metric_type,value,unit\n2026-09-01T06:00:00+05:30,resting_heart_rate,62,bpm\n2026-09-01T06:00:00+05:30,spo2,97,%\n2026-09-01T06:00:00+05:30,weight_kg,72,kg\n";
export function normaliseCsv(raw: unknown) {
  const row = z.array(z.string()).length(4).safeParse(raw);
  if (!row.success) return [];
  const [recorded_at, metric_type, text, unit] = row.data.map(v => v.trim());
  return canonicalMetric({ recorded_at, metric_type, value: text === "" ? NaN : Number(text), unit, quality: "raw" });
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
