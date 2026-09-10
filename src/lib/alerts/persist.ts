import type postgres from "postgres";
import { baselinesFor } from "../analytics/derive";
import { addDays } from "../analytics/time";
import type { DailySummary } from "../analytics";
import { alertCopy, alertRule, evaluateAlerts, metricLabels, type AlertMetric } from "./rules";

export async function persistAlerts(tx: Pick<postgres.Sql, "unsafe">, table: (name: string) => string, profile: { id: string; timezone: string; local_emergency_number: string; owner_account_id: string }, days: string[], metrics: AlertMetric[], summaries: DailySummary[], now: Date) {
  const t = table;
  const rows = await tx.unsafe("select distinct on(rule_key) * from " + t("alert_rules") + " where user_id is null or user_id=$1 order by rule_key,user_id nulls last", [profile.id]);
  const monitorRows = await tx.unsafe("select r.* from " + t("monitoring_rules") + " r where r.user_id=$1 and r.enabled and ((r.author_role='owner' and r.author_account_id=$2) or (exists(select 1 from " + t("consents") + " c where c.user_id=$1 and c.consent_type::text='doctor_sharing' and c.revoked_at is null) and ((r.author_role='caregiver' and exists(select 1 from " + t("caregiver_links") + " l where l.patient_id=$1 and l.caregiver_id=r.author_account_id and l.role='caregiver' and l.status='active' and l.revoked_at is null and 'alerts'=any(l.granted_scopes))) or (r.author_role='doctor' and exists(select 1 from " + t("doctor_patient_links") + " l join " + t("doctors") + " d on d.id=l.doctor_id join " + t("profiles") + " p on p.id=d.id where l.patient_id=$1 and p.auth_user_id=r.author_account_id and p.role='doctor' and d.verified_at is not null and l.status='active' and l.revoked_at is null and 'alerts'=any(l.granted_scopes))))))", [profile.id, profile.owner_account_id]);
  const monitorByKey = new Map<string, { id: string; author: string }>();
  const monitorRules = monitorRows.map(row => {
    const ruleKey = `monitor:${row.id}`;
    monitorByKey.set(ruleKey, { id: String(row.id), author: String(row.author_account_id) });
    return alertRule.parse({ ...row, rule_key: ruleKey });
  });
  const rules = [...rows.map(row => alertRule.parse(row)), ...monitorRules];
  for (const day of days) {
    const baseline = baselinesFor(summaries, addDays(day, -1));
    for (const event of evaluateAlerts(metrics, baseline, rules, { day, timezone: profile.timezone, now })) {
      const time = new Intl.DateTimeFormat("en-IN", { timeZone: profile.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(event.peakAt));
      const monitor = monitorByKey.get(event.rule.rule_key);
      const metricName = metricLabels[event.rule.metric_type] || event.rule.metric_type;
      const body = monitor
        ? `Monitoring alert: ${metricName} was ${event.valueLabel} at ${time}. This crossed a shared monitoring threshold. If you feel unwell, call ${profile.local_emergency_number} or contact your doctor.`
        : alertCopy(metricName, event.valueLabel, time, profile.local_emergency_number);
      const snapshot = { metric_type: event.rule.metric_type, value: event.peak, recorded_at: event.peakAt, value_label: event.valueLabel, rule_key: event.rule.rule_key, body, duration_s: event.duration_s, deviation_mads: event.deviation_mads, time, sample_label: event.isSample ? "Sample data" : null, configured_by_monitor: Boolean(monitor) };
      const old = monitor
        ? await tx.unsafe("select id,metric_snapshot from " + t("alerts") + " where user_id=$1 and monitoring_rule_id=$2 and source_id=$3 and event_start<=$4 and event_end>=$5", [profile.id, monitor.id, event.sourceId, event.end, event.start])
        : await tx.unsafe("select id,metric_snapshot from " + t("alerts") + " where user_id=$1 and rule_id=$2 and source_id=$3 and event_start<=$4 and event_end>=$5", [profile.id, event.rule.id, event.sourceId, event.end, event.start]);
      if (old.length) {
        // One continuous episode stays one alert even when a later batch extends it.
        const low = event.rule.comparator === "lt" || event.rule.comparator === "lte";
        const replace = low ? event.peak < Number(old[0].metric_snapshot.value) : event.peak > Number(old[0].metric_snapshot.value);
        await tx.unsafe("update " + t("alerts") + " set event_start=least(event_start,$2),event_end=greatest(event_end,$3),metric_snapshot=case when $4 then $5::text::jsonb else metric_snapshot end where id=$1", [old[0].id, event.start, event.end, replace, JSON.stringify(snapshot)]);
        continue;
      }
      const historical = !event.isSample && now.getTime() - Date.parse(event.end) > 86400000;
      const due = event.rule.severity === "urgent" && !historical ? new Date(now.getTime() + 900000) : null;
      const [alert] = await tx.unsafe("insert into " + t("alerts") + "(user_id,rule_id,monitoring_rule_id,source_id,metric_snapshot,severity,fired_at,event_start,event_end,is_sample,is_historical,escalation_due_at) values($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8,$9,$10,$11,$12) returning id", [profile.id, monitor ? null : event.rule.id, monitor?.id ?? null, event.sourceId, JSON.stringify(snapshot), event.rule.severity, now, event.start, event.end, event.isSample, historical, due]);
      if (!historical) {
        // Permissions and consent are checked again immediately before delivery.
        await tx.unsafe("insert into " + t("alert_deliveries") + "(user_id,alert_id,recipient_kind,recipient_key,channel,available_at) values($1,$2,'owner',$3,'email',$4),($1,$2,'owner',$3,'push',$4) on conflict do nothing", [profile.id, alert.id, profile.owner_account_id, now]);
        if (monitor && monitor.author !== profile.owner_account_id) {
          await tx.unsafe("insert into " + t("alert_deliveries") + "(user_id,alert_id,recipient_kind,recipient_key,channel,available_at) values($1,$2,'monitor',$3,'email',$4),($1,$2,'monitor',$3,'push',$4) on conflict do nothing", [profile.id, alert.id, monitor.author, now]);
        } else if (!monitor) {
          await tx.unsafe("insert into " + t("alert_deliveries") + "(user_id,alert_id,recipient_kind,recipient_key,channel,available_at) select $1,$2,'caregiver',caregiver_id::text,channel,$3 from " + t("caregiver_links") + " cross join (values('email'),('push')) channels(channel) where patient_id=$1 and role in ('caregiver','guardian') and status='active' and revoked_at is null and 'alerts'=any(granted_scopes) on conflict do nothing", [profile.id, alert.id, now]);
        }
      }
    }
  }
}
