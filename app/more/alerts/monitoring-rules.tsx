"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { metricTypes, units, type MetricType } from "@/src/lib/ingestion/model";
import { metricLabels } from "@/src/lib/alerts/rules";

const excluded = new Set<MetricType>(["sleep_stage", "menstrual_flow"]);
const availableMetrics = metricTypes.filter(metric => !excluded.has(metric));
const comparisons = { lt: "below", lte: "at or below", gt: "above", gte: "at or above" } as const;
const limits: Partial<Record<MetricType, { min: number; max: number; step: number; suggested?: number; duration?: number; note: string }>> = {
  spo2: { min: 50, max: 100, step: .1, suggested: 90, duration: 600, note: "SpO₂ readings can lag or be affected by fit, movement and circulation. Confirm unexpected values and follow the person's care plan." },
  heart_rate: { min: 20, max: 300, step: 1, suggested: 150, duration: 300, note: "Heart-rate meaning depends on rest, exercise, medication and the individual." },
  resting_heart_rate: { min: 20, max: 220, step: 1, note: "For personalised monitoring, a baseline-deviation rule is usually more meaningful than one universal value." },
  hrv_rmssd: { min: 0, max: 1000, step: .1, note: "HRV is device- and person-specific; compare like-for-like readings from the same source." },
  respiratory_rate: { min: 1, max: 100, step: .1, note: "Wearables often derive respiratory rate during sleep rather than streaming it continuously." },
  steps: { min: 0, max: 200000, step: 1, note: "Activity totals usually update periodically, not on every step." },
  active_calories: { min: 0, max: 50000, step: 1, note: "Wearable calorie values are estimates." },
  total_calories: { min: 0, max: 50000, step: 1, note: "Wearable calorie values are estimates." },
  sleep_duration: { min: 0, max: 1440, step: 1, note: "This checks reported sleep duration. It cannot detect missing sleep until the device supplies a completed sleep record." },
  stress_score: { min: 0, max: 100, step: 1, note: "Stress scores are proprietary estimates and are not interchangeable between brands." },
  weight_kg: { min: .5, max: 500, step: .1, note: "Smart scales produce one event after a completed weigh-in, not a continuous stream." },
  body_fat_pct: { min: 1, max: 75, step: .1, note: "Consumer scale body-fat estimates vary with hydration and measurement conditions." },
  blood_pressure_systolic: { min: 30, max: 300, step: 1, note: "HMS evaluates blood-pressure alerts only from explicitly user-entered cuff readings." },
  blood_pressure_diastolic: { min: 20, max: 200, step: 1, note: "HMS evaluates blood-pressure alerts only from explicitly user-entered cuff readings." },
  blood_glucose: { min: 20, max: 1000, step: 1, note: "Glucose targets are highly individual. Use only a clinician-agreed care plan and compatible approved source." },
  vo2max: { min: 1, max: 100, step: .1, note: "VO₂ max is normally an occasional device estimate, not a live measurement." },
  basal_body_temperature: { min: 30, max: 45, step: .01, note: "Use values from an appropriate thermometer and a clinician-agreed threshold." },
};
const ruleSchema = z.object({
  id: z.uuid(), author_role: z.enum(["owner", "caregiver", "doctor"]), author_name: z.string(),
  metric_type: z.enum(metricTypes), comparator: z.enum(["lt", "lte", "gt", "gte"]), threshold_type: z.enum(["absolute", "baseline_deviation"]),
  value: z.coerce.number(), min_duration_s: z.number().int(), severity: z.enum(["info", "attention", "urgent"]), can_edit: z.boolean(),
});
const channelSchema = z.object({ recipient: z.string(), is_current: z.boolean(), email_enabled: z.boolean(), push_enabled: z.boolean() });
const deliverySchema = z.object({ recipient: z.string(), channel: z.enum(["email", "push"]), status: z.enum(["pending", "sent", "stubbed", "cancelled", "failed"]), delivered_at: z.string().nullable() });
const activitySchema = z.object({ id: z.uuid(), fired_at: z.string(), severity: z.string(), acknowledged_at: z.string().nullable(), is_historical: z.boolean(), is_sample: z.boolean(), body: z.string().nullable(), deliveries: z.array(deliverySchema) });
const responseSchema = z.object({ rules: z.array(ruleSchema), channels: z.array(channelSchema), activity: z.array(activitySchema) });
type Rule = z.infer<typeof ruleSchema>;
type MonitoringData = z.infer<typeof responseSchema>;

function label(metric: MetricType) {
  return metricLabels[metric] || metric.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
}

export function MonitoringRules({ profile }: { profile: { id: string; name: string } }) {
  const [data, setData] = useState<MonitoringData>({ rules: [], channels: [], activity: [] });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [metric, setMetric] = useState<MetricType>("spo2");
  const [comparator, setComparator] = useState<keyof typeof comparisons>("lt");
  const [basis, setBasis] = useState<"absolute" | "baseline_deviation">("absolute");
  const [value, setValue] = useState("90");
  const [duration, setDuration] = useState("600");
  const [severity, setSeverity] = useState<"info" | "attention" | "urgent">("urgent");
  const request = useCallback(async (action: "read" | "upsert" | "remove", payload = {}, signal?: AbortSignal) => {
    const response = await fetch("/api/alerts/monitoring", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: profile.id, action, payload }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not save the monitoring rule.");
    return body;
  }, [profile.id]);
  const refresh = useCallback(async (signal?: AbortSignal) => setData(responseSchema.parse(await request("read", {}, signal))), [request]);
  useEffect(() => {
    const controller = new AbortController();
    request("read", {}, controller.signal).then(result => { if (!controller.signal.aborted) setData(responseSchema.parse(result)); })
      .catch(error => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not load rules."); });
    return () => controller.abort();
  }, [request]);
  const chosen = basis === "baseline_deviation" ? { min: .1, max: 20, step: .1, suggested: 4, duration: 1800, note: "Baseline rules require at least seven suitable days and compare this person with their own history." } : limits[metric]!;
  function chooseMetric(next: MetricType) {
    const nextBasis = next === "skin_temperature" ? "baseline_deviation" : "absolute";
    const config = nextBasis === "baseline_deviation" ? { suggested: 4, duration: 1800 } : limits[next];
    setMetric(next); setBasis(nextBasis); setValue(String(config?.suggested ?? "")); setDuration(String(config?.duration ?? 0)); setSeverity(config?.suggested ? "urgent" : "attention");
  }
  function startEdit(rule: Rule) {
    setEditing(rule); setMetric(rule.metric_type); setComparator(rule.comparator); setBasis(rule.threshold_type);
    setValue(String(rule.value)); setDuration(String(rule.min_duration_s)); setSeverity(rule.severity); setMessage("Editing this rule. Its parameter and trigger stay fixed to prevent accidental duplication.");
  }
  function cancelEdit() { setEditing(null); chooseMetric("spo2"); setComparator("lt"); setMessage(""); }
  async function remove(ruleId: string) {
    setBusy(true); setMessage("");
    try { await request("remove", { ruleId }); await refresh(); if (editing?.id === ruleId) cancelEdit(); setMessage("Monitoring rule removed. Pending deliveries from it were cancelled."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not remove the rule."); }
    finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      await request("upsert", { metricType: metric, comparator, thresholdType: metric === "skin_temperature" ? "baseline_deviation" : basis, value: Number(value), duration: Number(duration), severity, enabled: true });
      await refresh(); setEditing(null); setMessage("Monitoring rule saved. New qualifying readings will notify the profile owner and you through enabled email or push channels.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save the rule."); }
    finally { setBusy(false); }
  }
  return <div className="stack">
    <section className="card stack">
      <div><h2 className="type-section">Shared monitoring thresholds</h2><p className="muted">Doctors, family caregivers, and profile owners with alert access can set a reading threshold for {profile.name}. When a new reading stays beyond it for the chosen duration, the profile owner and the person who set the rule are notified through enabled channels.</p></div>
      <form onSubmit={submit} className="stack"><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label>Parameter<select className="mt-1 block w-full" disabled={Boolean(editing)} value={metric} onChange={event => chooseMetric(event.target.value as MetricType)}>{availableMetrics.map(item => <option key={item} value={item}>{label(item)}</option>)}</select></label>
        <label>Trigger<select className="mt-1 block w-full" disabled={Boolean(editing)} value={comparator} onChange={event => setComparator(event.target.value as keyof typeof comparisons)}>{Object.entries(comparisons).map(([item, text]) => <option key={item} value={item}>{text}</option>)}</select></label>
        <label>Threshold<input aria-label="Monitoring threshold" className="mt-1 block w-full" type="number" min={chosen.min} max={chosen.max} step={chosen.step} value={value} onChange={event => setValue(event.target.value)} required /></label>
        <label>Threshold basis<select disabled={metric === "skin_temperature" || Boolean(editing)} className="mt-1 block w-full" value={basis} onChange={event => { const next = event.target.value as typeof basis; setBasis(next); setValue(next === "baseline_deviation" ? "4" : String(limits[metric]?.suggested ?? "")); }}><option value="absolute">Measured value ({units[metric]})</option><option value="baseline_deviation">Personal baseline (MADs)</option></select></label>
        <label>Sustained for (seconds)<input className="mt-1 block w-full" type="number" min="0" max="86400" step="1" value={duration} onChange={event => setDuration(event.target.value)} required /></label>
        <label>Priority<select className="mt-1 block w-full" value={severity} onChange={event => setSeverity(event.target.value as typeof severity)}><option value="info">Information</option><option value="attention">Attention</option><option value="urgent">Urgent</option></select></label>
      </fieldset><p className="muted">{chosen.note} {chosen.suggested !== undefined && <>The prefilled value is an illustrative starting point, not a prescription; confirm it with the person’s clinician.</>}</p><div className="flex flex-wrap gap-3"><button disabled={busy} className="button secondary">{busy ? "Saving…" : editing ? "Save changes" : "Add my rule"}</button>{editing && <button type="button" disabled={busy} onClick={cancelEdit} className="underline">Cancel editing</button>}</div></form>
      <p role="status" className="muted">{message}</p>
      <div className="stack">{data.rules.map(rule => <article key={rule.id} className="panel flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">{label(rule.metric_type)} {comparisons[rule.comparator]} {rule.value} {rule.threshold_type === "absolute" ? units[rule.metric_type] : "MADs from baseline"}</p><p className="muted">For {rule.min_duration_s} seconds, {rule.severity}, Set by {rule.author_name} ({rule.author_role})</p></div>{rule.can_edit && <div className="flex gap-3"><button disabled={busy} onClick={() => startEdit(rule)} className="text-sm underline">Edit</button><button disabled={busy} onClick={() => void remove(rule.id)} className="text-sm underline">Remove</button></div>}</article>)}{data.rules.length === 0 && <p className="muted">No shared monitoring thresholds yet.</p>}</div>
      <p className="muted">HMS processes a reading immediately after receiving it. End-to-end delay also includes the wearable’s device-to-phone-to-provider sync, which HMS cannot control. This is monitoring support, not emergency detection or a substitute for medical care.</p>
    </section>
    <section className="card stack"><h2 className="type-section">Notification readiness</h2>{data.channels.map(channel => <p key={channel.recipient}><strong>{channel.recipient}{channel.is_current ? " (this account)" : ""}:</strong> Email {channel.email_enabled ? "enabled" : "off"}, Push {channel.push_enabled ? "enabled" : "off"}</p>)}<p className="muted">A rule can create an in-app alert even when email and push are off. Enable at least one external channel on each account that should be notified.</p></section>
    <section className="card stack"><h2 className="type-section">Recent alert delivery activity</h2>{data.activity.map(item => <article key={item.id} className="panel stack"><p className="font-medium">{item.severity}, {item.acknowledged_at ? "Acknowledged" : "Not acknowledged"}{item.is_historical ? ", Historical" : ""}{item.is_sample ? ", Sample data" : ""}</p><p>{item.body || "Reading details unavailable."}</p><p className="muted">Fired {new Date(item.fired_at).toLocaleString()}</p>{item.deliveries.length ? <ul className="list-disc pl-5 muted">{item.deliveries.map((delivery, index) => <li key={`${delivery.recipient}:${delivery.channel}:${index}`}>{delivery.recipient}, {delivery.channel}, {delivery.status}{delivery.delivered_at ? ` at ${new Date(delivery.delivered_at).toLocaleString()}` : ""}</li>)}</ul> : <p className="muted">In-app only; no external delivery was queued.</p>}</article>)}{data.activity.length === 0 && <p className="muted">No alert activity yet.</p>}</section>
  </div>;
}
