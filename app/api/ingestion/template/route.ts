import { CSV_TEMPLATE } from "@/src/lib/ingestion/csv";
export function GET() {
  return new Response(CSV_TEMPLATE, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="hms-template.csv"' } });
}
