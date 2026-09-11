"use client";
import { useEffect,useState,useSyncExternalStore } from "react";
import { patientPost,readView,type PatientView } from "@/src/lib/patient/model";
import { useRealtimePatientView } from "@/src/lib/patient/realtime";
import { AlertIcon } from "../ui/icons";
import { DataChart } from "../ui/chart";
import { addDays } from "@/src/lib/analytics/time";
import { buildSeries, formatValue, type DayValue } from "@/src/lib/patient/chart";
import type { Summary } from "@/src/lib/patient/model";
const STALE_AFTER_MS=6*60*60*1000;
function subscribeMinute(callback:()=>void) { const timer=setInterval(callback,60000); return ()=>clearInterval(timer); }
function formatDate(day:string) { const date=new Date(day+"T00:00:00Z"); return Number.isNaN(date.getTime())?day:date.toLocaleDateString("en-GB",{weekday:"long",timeZone:"UTC"})+", "+date.toLocaleDateString("en-GB",{day:"numeric",month:"long",timeZone:"UTC"}); }
// §7.5: freshness comes from the newest summary computation, which happens whenever new readings land.
function Freshness({syncedAt,timezone}:{syncedAt:string|null;timezone:string}) {
  // The clock ticks once a minute; the server snapshot is null so the first paint never disagrees with hydration.
  const now=useSyncExternalStore(subscribeMinute,()=>Math.floor(Date.now()/60000)*60000,()=>null);
  const synced=syncedAt?Date.parse(syncedAt):NaN;
  const age=now!==null&&Number.isFinite(synced)?now-synced:null;
  const stale=age===null||age>STALE_AFTER_MS;
  let text="Checking last sync…";
  if(now!==null&&!Number.isFinite(synced)) text="Not synced yet";
  else if(age!==null&&!stale) { const minutes=Math.floor(age/60000); text=minutes<1?"Synced just now":minutes<60?"Synced "+minutes+(minutes===1?" minute ago":" minutes ago"):"Synced "+Math.floor(minutes/60)+(Math.floor(minutes/60)===1?" hour ago":" hours ago"); }
  else if(age!==null) text="Last synced "+new Date(synced).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",timeZone:timezone});
  return <p className="freshness"><span className={"freshness-dot"+(stale?" stale":"")} aria-hidden="true"/><span>{text}</span></p>;
}
const metricIcons={
  rhr:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12h4l2-5 3 10 3-7 2 2h6"/></svg>,
  sleep:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 13h4l2 6 3-14 2 8h5"/></svg>,
};
// One sentence about the latest value against the 28-day band, in the reference's words.
function usualRange(values:DayValue[]) {
  const series=buildSeries(values);
  if(!series.last) return {series,sentence:"No readings yet."};
  if(series.baselineDays<28) return {series,sentence:"Not enough history yet to say what's usual."};
  if(!series.lastOutside||!series.lastBand) return {series,sentence:"Within your usual range."};
  const above=series.last.value!>series.lastBand.high;
  let days=0;for(const point of [...series.points].reverse()){ if(point.value===null) break; const outside=above?point.value>series.lastBand.high:point.value<series.lastBand.low; if(!outside) break; days++; }
  const span=days<=1?"today":days===2?"the last two days":days===3?"the last three days":"the last "+days+" days";
  return {series,sentence:(above?"Above":"Below")+" your usual range for "+span+"."};
}
function MetricCard({icon,label,value,unit,sentence,values,kind,testId,sample}:{icon:React.ReactNode;label:string;value:React.ReactNode;unit?:string;sentence:string;values:DayValue[];kind:"line"|"bars";testId?:string;sample?:boolean}) {
  return <section className="card metric-card" data-testid={testId}>
    {sample&&<span className="badge">Sample data</span>}
    <p className="metric-label">{icon}<span>{label}</span></p>
    <p className="hero-figure"><span className="hero-score">{value}</span>{unit&&<span className="unit">{unit}</span>}</p>
    <p className="metric-sentence">{sentence}</p>
    {values.some(v=>v.value!==null)&&<DataChart values={values} kind={kind} label={label} unit={unit??""} height={kind==="bars"?56:80} />}
  </section>;
}
function sleepLabel(minutes:number) { const h=Math.floor(minutes/60),m=Math.round(minutes%60); return <>{h}<small>h</small> {m}<small>m</small></>; }
export function Today({initial,today}:{initial:PatientView;today:string}) {
  // The reference Today shows the last 30 days behind each metric. Full-history readers load them; summary-only readers keep the single-value hero.
  const [rows,setRows]=useState<Summary[]|null>(null);
  const {view,setView,live}=useRealtimePatientView(initial,"today");
  const [message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  const userId=initial.profile.id;
  useEffect(()=>{
    if(!initial.pending_jobs || !initial.ingestion_consent || !initial.can_manage) return;
    const controller=new AbortController();
    async function compute() {
      setBusy(true); setMessage("Your readings are saved. Updating your summary…");
      try {
        for(let n=0;n<20;n++) {
          await patientPost("/api/patient/refresh",{userId},controller.signal);
          const next=await readView(userId,"today",{signal:controller.signal}); setView(next);
          if(!next.pending_jobs) {setMessage("");return;}
        }
        setMessage("Some summaries are still queued. Refresh this page later.");
      } catch { if(!controller.signal.aborted) setMessage("Your readings are saved. Refresh later to retry the summary."); }
      finally { if(!controller.signal.aborted) setBusy(false); }
    }
    void compute();
    return ()=>controller.abort();
  },[initial,userId,setView]);
  const summary=view.summaries?.[0],alert=view.alerts?.[0];
  const latestComputed=summary?.computed_at;
  useEffect(()=>{
    if(!initial.can_read_history) return;
    const controller=new AbortController();
    void readView(userId,"history",{from:addDays(today,-29),to:today,signal:controller.signal}).then(next=>setRows(next.summaries??[])).catch(()=>{});
    return ()=>controller.abort();
  },[initial.can_read_history,userId,today,latestComputed]);
  const rhr=usualRange((rows??[]).map(r=>({day:r.day,value:r.rhr})));
  const sleepValues=(rows??[]).map(r=>({day:r.day,value:r.sleep_duration_min}));
  const sleepSeries=usualRange(sleepValues);
  const latestSleep=[...(rows??[])].sort((a,b)=>b.day.localeCompare(a.day)).find(r=>r.sleep_duration_min!==null)?.sleep_duration_min??summary?.sleep_duration_min??null;
  const latestRhr=rhr.series.last?.value??summary?.rhr??null;
  const showMetrics=Boolean(rows&&rows.length&&(latestRhr!==null||latestSleep!==null));
  // §6: two visual states. Urgent keeps its own rule; every other severity uses the attention pattern.
  const alertClass=alert?(alert.severity==="urgent"?"alert-urgent":"alert-attention"):"";
  async function acknowledge() {
    if(!alert) return;
    setBusy(true);setMessage("");
    try {await patientPost("/api/alerts/settings",{userId,action:"acknowledge",payload:{alertId:alert.id}});setView(await readView(userId,"today"));}
    catch(error){setMessage(error instanceof Error?error.message:"Please try again.");} finally{setBusy(false);}
  }
  return <div className="stack">
    <header className="page-header"><h1 className="page-title">Today</h1><p className="page-date">{formatDate(today)}</p><Freshness syncedAt={summary?.computed_at??null} timezone={view.profile.timezone}/></header>
    <p className="muted" role="status"><span className={live==="live"?"live-dot":"live-dot offline"} aria-hidden="true" /> {live==="live"?"Live updates connected":live==="connecting"?"Connecting live updates…":"Live connection interrupted; retrying automatically"}</p>
    {showMetrics&&latestRhr!==null&&<MetricCard testId={alert?undefined:"today-hero"} sample={view.contains_sample} icon={metricIcons.rhr} label="Resting heart rate" value={formatValue(latestRhr)} unit="bpm" sentence={rhr.sentence} values={(rows??[]).map(r=>({day:r.day,value:r.rhr}))} kind="line"/>}
    {showMetrics&&latestSleep!==null&&<MetricCard icon={metricIcons.sleep} label="Sleep" value={sleepLabel(latestSleep)} sentence={"Last night. "+sleepSeries.sentence} values={sleepValues} kind="bars"/>}
    {(alert||!showMetrics)&&<section className={"card stack "+alertClass} data-testid="today-hero">
      {(view.contains_sample || alert?.is_sample) && <span className="badge">Sample data</span>}
      {view.consent_given_by_guardian && <p className="muted">Consent given by guardian</p>}
      {alert?<>
        <div className="alert-label"><AlertIcon severity={alert.severity}/><h2 className="sentence">{alert.severity} reading</h2></div>
        <p>{alert.metric_snapshot.body}</p>
        {alert.is_historical && <p className="muted">Historical sample event. No external notification was sent.</p>}
        {view.can_manage?<button className="button secondary" disabled={busy} onClick={()=>void acknowledge()}>Acknowledge reading</button>:<p className="muted">Read-only shared view</p>}
        {(view.active_alert_count??0)>1 && <p className="muted">{view.active_alert_count} unacknowledged readings. The highest priority is shown first.</p>}
      </>:summary?<>
        <h2 className="type-section">Your readiness</h2>
        <p className="hero-figure"><span className="hero-score">{summary.readiness_score??"—"}</span>{summary.readiness_score!==null&&<span className="unit">/ 100</span>}</p>
        <p>{summary.readiness_score===null?"A score needs resting heart rate, HRV and sleep, with at least seven prior days for each.":"A guide to your recent recovery. Not a medical assessment."}</p>
        <p className="muted">Latest readings: {summary.day}. Resting HR {summary.rhr??"—"} bpm · HRV {summary.hrv_avg===null?"—":Math.round(summary.hrv_avg)} ms · Sleep {summary.sleep_duration_min===null?"—":(summary.sleep_duration_min/60).toFixed(1)} h.</p>
        <a className="underline text-sm" href={"/more/advanced?profile="+userId}>How this score works</a>
      </>:<><h2 className="type-section">Your history starts here.</h2><p>Import your readings or explore clearly labelled sample data.</p>{view.can_manage&&<a className="button secondary" href={"/more/data?profile="+userId}>Connect data</a>}</>}
      {message&&<p role="status" className="muted">{message}</p>}
    </section>}
    {showMetrics&&!alert&&message&&<p role="status" className="muted">{message}</p>}
    {showMetrics&&!alert&&view.consent_given_by_guardian&&<p className="muted">Consent given by guardian</p>}
    {(view.insights??[]).slice(0,3).map(insight=><article className="card insight stack" key={insight.id} data-testid="insight-card">
      {view.contains_sample&&<span className="badge">Sample data</span>}<h2>{insight.title}</h2><p>{insight.body}</p><p className="muted">Confidence: {insight.confidence}.</p>
      <footer><a className="underline" href="/legal/disclaimer">Discuss with your doctor.</a></footer>
    </article>)}
    <a className="button" href={"/doctors?profile="+userId}>Talk to a doctor</a>
  </div>;
}
