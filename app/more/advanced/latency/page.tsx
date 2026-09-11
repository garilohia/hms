import { z } from "zod";
import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "@/app/ui/frame";

const number = z.coerce.number().nullable();
const reportSchema = z.object({
  measured_at: z.string(),
  sources: z.array(z.object({
    id: z.uuid(), provider: z.string(), label: z.string().nullable(), connection: z.string().nullable(), platform: z.string().nullable(),
    last_sync_at: z.string().nullable(), cadence: z.number().int().nullable(), sample: z.boolean().nullable(), freshness: z.enum(["manual", "waiting", "current", "delayed"]),
  })),
  metrics: z.array(z.object({
    source_id: z.uuid(), metric_type: z.string(), count: z.coerce.number(), last_recorded_at: z.string(), last_received_at: z.string(),
    p50_source_seconds: number, p95_source_seconds: number,
  })),
  alerts: z.object({ count: z.coerce.number(), p50_seconds: number, p95_seconds: number }),
  deliveries: z.object({ count: z.coerce.number(), p50_seconds: number, p95_seconds: number }),
});

function duration(value: number | null) {
  if (value === null) return "Not measured yet";
  if (value < 1) return `${Math.round(value * 1000)} ms`;
  if (value < 120) return `${Number(value.toFixed(1))} s`;
  if (value < 7200) return `${Number((value / 60).toFixed(1))} min`;
  return `${Number((value / 3600).toFixed(1))} h`;
}

export default async function LatencyPage({ searchParams }: { searchParams: Promise<{ profile?: string }> }) {
  const { view, profiles, session } = await patientPage("advanced", (await searchParams).profile);
  const { data, error } = await session.client.rpc("hms_latency_report", { p_subject: view.profile.id });
  if (error) throw new Error(`Latency report temporarily unavailable (${error.code}).`);
  const report = reportSchema.parse(data);
  const sourceNames = new Map(report.sources.map(source => [source.id, source.label || source.provider.replaceAll("_", " ")]));
  return <AppFrame profile={view.profile} profiles={profiles}><div className="stack"><div><h1 className="page-title">Data freshness and latency</h1><p className="muted">Measured delivery timing for {view.profile.name}. Estimates are never presented as measurements.</p></div>
    <section className="card stack"><h2 className="font-semibold">Pipeline timing, last 30 days</h2><div className="grid gap-3 sm:grid-cols-2">
      <div className="panel"><p className="muted">Reading recorded → alert created</p><p className="type-title">{duration(report.alerts.p50_seconds)} median</p><p className="muted">95th percentile {duration(report.alerts.p95_seconds)}, {report.alerts.count} alerts</p></div>
      <div className="panel"><p className="muted">Alert created → external delivery</p><p className="type-title">{duration(report.deliveries.p50_seconds)} median</p><p className="muted">95th percentile {duration(report.deliveries.p95_seconds)}, {report.deliveries.count} completed deliveries</p></div>
    </div><p className="muted">The first number includes device and provider delay. HMS cannot react before a reading reaches it. An absent sleep or temperature record means “no data received,” not that the event did or did not happen.</p></section>
    <section className="card stack"><h2 className="font-semibold">Source freshness</h2>{report.sources.length ? report.sources.map(source => <div className="list-row" key={source.id}><span><strong>{source.label || source.provider.replaceAll("_", " ")}</strong><span className="block muted">{source.platform?.replaceAll("_", " ") || source.connection || source.provider.replaceAll("_", " ")}{source.sample ? ", Sample data" : ""}</span></span><span className={`badge ${source.freshness === "delayed" ? "attention" : ""}`}>{source.freshness === "manual" ? "Manual import" : source.freshness === "waiting" ? "Waiting for first sync" : source.freshness === "current" ? "Current" : "Feed delayed"}</span></div>) : <p>No data sources connected.</p>}
      <p className="muted">A continuous source is marked delayed after three expected update intervals, with a minimum five-minute grace period. This describes the feed, not the person’s health.</p></section>
    <section className="card stack"><h2 className="font-semibold">Measured source delay by parameter</h2>{report.metrics.length ? report.metrics.map(metric => <div className="list-row" key={`${metric.source_id}:${metric.metric_type}`}><span><strong>{metric.metric_type.replaceAll("_", " ")}</strong><span className="block muted">{sourceNames.get(metric.source_id) || "Data source"}, {metric.count} readings</span></span><span className="text-right">{duration(metric.p50_source_seconds)} median<span className="block muted">p95 {duration(metric.p95_source_seconds)}</span></span></div>) : <p>No readings received in the last 30 days.</p>}</section>
    <section className="card stack"><h2 className="font-semibold">Safety interpretation</h2><p>HMS records when the device says a reading occurred and when HMS received it. It then records alert creation, delivery attempts and acknowledgement separately.</p><p className="muted">“Current” does not mean every parameter is current: sleep, HRV, SpO₂ and temperature may be produced less often than heart rate. Device fit, phone connectivity, battery saving, provider processing and permission changes can all delay data. Never rely on HMS for emergencies.</p></section>
  </div></AppFrame>;
}
