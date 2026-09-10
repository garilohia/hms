"use client";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { alertRule, defaultRules, metricLabels } from "@/src/lib/alerts/rules";
import { units } from "@/src/lib/ingestion/model";
const comparisons = { lt: "below", lte: "at or below", gt: "above", gte: "at or above" };
const settings = z.object({ rules: z.array(alertRule), consents: z.array(z.string()), contact: z.object({ name: z.string().optional(), phone: z.string().optional(), email: z.string().optional() }).nullable(),
  alerts: z.array(z.object({ id: z.uuid(), severity: z.string(), acknowledged_at: z.string().nullable(), is_sample: z.boolean(), is_historical: z.boolean(), metric_snapshot: z.object({ body: z.string().optional() }) })) });
type Settings = z.infer<typeof settings>;
export function AlertSettings({ profiles }: { profiles: { id: string; name: string }[] }) {
  const [subject, setSubject] = useState(profiles[0]?.id || "");
  const [data, setData] = useState<Settings | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useCallback(async (action: string, payload = {}, signal?: AbortSignal) => {
    const response = await fetch("/api/alerts/settings", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: subject, action, payload }) });
    if (!response.ok) throw new Error("Could not update alerts. Check the details and your access.");
    return response.json();
  }, [subject]);
  useEffect(() => {
    const controller = new AbortController();
    if (subject) request("read", {}, controller.signal).then(value => { if (!controller.signal.aborted) setData(settings.parse(value)); }).catch(() => { if (!controller.signal.aborted) setMessage("Could not load alerts. Reload to retry."); });
    return () => controller.abort();
  }, [subject, request]);
  async function action(name: string, payload = {}) {
    setBusy(true); setMessage("");
    try { await request(name, payload); setData(settings.parse(await request("read"))); setMessage("Saved."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save."); }
    finally { setBusy(false); }
  }
  async function consent(type: string, grant: boolean) {
    const previous = data;
    setBusy(true); setMessage("Saving consent…");
    if (data) setData({ ...data, consents: grant ? [...new Set([...data.consents, type])] : data.consents.filter(c => c !== type) });
    try {
      const response = await fetch("/api/consents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: subject, type, grant }) });
      if (!response.ok) throw new Error("Could not change consent.");
      setData(settings.parse(await request("read"))); setMessage("Consent updated.");
    } catch { setData(previous); setMessage("Could not change consent. Please retry."); } finally { setBusy(false); }
  }
  return <div className="stack"><label className="block">Profile<select disabled={busy} value={subject} onChange={e => { setData(null); setMessage(""); setSubject(e.target.value); }} className="mt-1 block w-full">{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <p role="status">{message}</p>{data && <>
      <section className="stack"><h2 className="type-section">Unacknowledged alerts</h2>{data.alerts.filter(a => !a.acknowledged_at).slice(0, 20).map(a => <article key={a.id} className="card stack">{a.is_sample && <p className="text-sm font-semibold">Sample data</p>}<p className="capitalize">{a.severity}{a.is_historical ? " · Historical reading" : ""}</p><p>{a.metric_snapshot.body || "Reading details unavailable."}</p><button disabled={busy} onClick={() => action("acknowledge", { alertId: a.id })} className="button secondary">Acknowledge</button></article>)}
      {!data.alerts.some(a => !a.acknowledged_at) && <p>No unacknowledged alerts.</p>}<p className="muted">{data.alerts.filter(a => a.acknowledged_at).length} acknowledged alerts retained in history.</p></section>
      <section className="stack"><h2 className="type-section">Thresholds</h2>{data.rules.map(rule => {
        const recommended = defaultRules.find(r => r.rule_key === rule.rule_key);
        return <form key={rule.id + ":" + rule.value + ":" + rule.min_duration_s + ":" + rule.enabled} onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void action("rule", { key: rule.rule_key, value: Number(form.get("value")), duration: Number(form.get("duration")), enabled: form.get("enabled") === "on" }); }} className="card stack">
          <h3 className="font-semibold">{metricLabels[rule.metric_type]} · {rule.severity}</h3><p className="muted">Recommended: {comparisons[rule.comparator]} {recommended?.value}{rule.threshold_type === "baseline_deviation" ? " MAD from the personal baseline" : " " + units[rule.metric_type]}, for {recommended?.min_duration_s} seconds.</p>
          <fieldset disabled={busy} className="flex flex-wrap gap-3"><label>Threshold<input className="block w-28" name="value" aria-label={rule.rule_key + " threshold"} type="number" required min="0" max="10000" step="any" defaultValue={rule.value} /></label><label>Duration (seconds)<input className="block w-32" name="duration" type="number" required min="0" max="86400" defaultValue={rule.min_duration_s} /></label><label className="flex items-center gap-2"><input name="enabled" type="checkbox" defaultChecked={rule.enabled} />Enabled</label><button className="button secondary">Save rule</button><button type="button" onClick={() => action("reset_rule", { key: rule.rule_key })} className="underline">Restore recommended</button></fieldset>
        </form>;
      })}<p className="muted">Skin and wrist temperature rules detect a sustained personal outlier after at least seven baseline days; they do not diagnose fever. Confirm an alert with a clinical thermometer: wrist sensors are not thermometers and their values must not be compared with clinical body-temperature cutoffs. Alerts are prompts to check the person, not a diagnosis or emergency-service substitute.</p></section>
      <section className="card stack"><h2 className="type-section">Email and emergency contact</h2><label className="flex gap-2"><input type="checkbox" disabled={busy} checked={data.consents.includes("alert_email")} onChange={e => consent("alert_email", e.target.checked)} />Email me unusual-reading notices.</label>
        <form key={subject} onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void action("contact", { name: form.get("name"), phone: form.get("phone"), email: form.get("email") }); }} className="stack"><fieldset disabled={busy} className="stack">{(["name", "phone", "email"] as const).map(key => <label key={key} className="block capitalize">Contact {key}<input className="mt-1 block w-full" name={key} type={key === "email" ? "email" : "text"} maxLength={key === "name" ? 100 : key === "phone" ? 40 : 254} defaultValue={data.contact?.[key] || ""} /></label>)}<button className="button secondary">Save contact</button></fieldset></form>
        <p className="muted">Saving a contact clears previous forwarding consent. Give consent again after checking their email.</p><label className="flex gap-2"><input type="checkbox" disabled={busy || !data.contact?.email} checked={data.consents.includes("emergency_contact")} onChange={e => consent("emergency_contact", e.target.checked)} />I consent to sending this profile’s unacknowledged urgent notices to this contact after 15 minutes.</label><p className="muted">Email is a console stub without Resend configuration. Sample data always uses the stub. SMS and WhatsApp are not enabled. Do not rely on notifications for emergencies.</p>
      </section></>}
  </div>;
}
