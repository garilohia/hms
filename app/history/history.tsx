"use client";
import { useEffect,useState } from "react";
import { z } from "zod";
import { addDays } from "@/src/lib/analytics/time";
import { chartMetrics,summaryValues,type ChartMetric } from "@/src/lib/patient/chart";
import { patientPost,readView,type PatientView,type Summary } from "@/src/lib/patient/model";
import { DataChart,PhaseSwatch,cyclePhases } from "../ui/chart";
import {DocumentUpload} from "./document-upload";
// The band needs the 28 days before the visible range, so every loaded row is kept as baseline source.
function mergeRows(previous:Summary[],next:Summary[]) { const byDay=new Map(previous.map(r=>[r.day,r])); for(const row of next) byDay.set(row.day,row); return [...byDay.values()]; }
export function History({initial,today}:{initial:PatientView;today:string}) {
  const [view,setView]=useState(initial),[metric,setMetric]=useState<ChartMetric>("RHR"),[range,setRange]=useState("90"),[selected,setSelected]=useState<Summary|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [baselineRows,setBaselineRows]=useState<Summary[]>(initial.summaries??[]);
  const [device,setDevice]=useState<{id:string;label:string}|null>(null),[docs,setDocs]=useState<PatientView|null>(null),[alerts,setAlerts]=useState<PatientView|null>(null),[alertDay,setAlertDay]=useState<string|null>(null);
  const userId=initial.profile.id;
  useEffect(()=>{const controller=new AbortController();
    void readView(userId,"documents",{signal:controller.signal}).then(setDocs).catch(()=>{if(!controller.signal.aborted)setError("Document details could not load. Refresh to retry.");});
    return()=>controller.abort();},[userId]);
  const from=range==="All"?null:addDays(today,1-Number(range));
  const rows=(view.summaries??[]).filter(r=>!from||r.day>=from);
  const config=chartMetrics[metric];
  const activeSource=selected?.source_ids[config.source];
  useEffect(()=>{
    const controller=new AbortController();
    if(activeSource) void patientPost("/api/patient/source",{userId,sourceId:activeSource},controller.signal).then(result=>{
      const source=z.object({label:z.string().nullable(),provider:z.string()}).parse(result);setDevice({id:activeSource,label:source.label??source.provider});
    }).catch(()=>{if(!controller.signal.aborted)setDevice({id:activeSource,label:"Source unavailable. Refresh to retry."});});
    return()=>controller.abort();
  },[activeSource,userId]);
  async function load(nextRange:string,cursor?:Record<string,string>|null) {
    setBusy(true);setError("");
    try {const next=await readView(userId,"history",{from:nextRange==="All"?null:addDays(today,1-Number(nextRange)),to:today,cursor});setView(next);setBaselineRows(previous=>mergeRows(previous,next.summaries??[]));setRange(nextRange);setSelected(null);setAlerts(null);}
    catch(e){setError(e instanceof Error?e.message:"Please try again.");}finally{setBusy(false);}
  }
  async function showAlerts(day:string,cursor?:Record<string,string>|null) {
    setBusy(true);setError("");
    try{setAlerts(await readView(userId,"alerts",{from:day,to:day,cursor}));setAlertDay(day);}catch(e){setError(e instanceof Error?e.message:"Please try again.");}finally{setBusy(false);}
  }
  const showPhases=metric==="Temp"&&initial.profile.cycle_tracking_enabled;
  return <div className="stack">
    <div aria-label="Metric" className="chips">{Object.keys(chartMetrics).map(key=><button key={key} aria-pressed={metric===key} onClick={()=>{setMetric(key as ChartMetric);setSelected(null);}}>{key}</button>)}</div>
    <div aria-label="History range" className="chips">{["7","30","90","365","All"].map(value=><button disabled={busy} key={value} aria-pressed={range===value} onClick={()=>void load(value)}>{value==="All"?"All":value+" days"}</button>)}</div>
    <section className="card stack">
      {rows.some(r=>r.contains_sample)&&<span className="badge">Sample data</span>}
      <h2 className="type-section">{metric} <span className="unit">{config.unit}</span></h2>
      {metric==="BP"&&<p className="muted">Systolic trend. Select a day for both blood pressure readings.</p>}
      {!rows.length?<p>No readings in this range. Try a longer range or connect data.</p>:<>
        <DataChart values={summaryValues(rows,metric)} baseline={summaryValues(baselineRows,metric)} kind={config.kind} label={config.label} unit={config.unit} animate
          markers={(view.markers??[]).filter(m=>rows.some(r=>r.day===m.day))} onMarker={day=>void showAlerts(day)} onPick={day=>setSelected(rows.find(r=>r.day===day)??null)}
          phases={showPhases?(view.cycles??[]).filter(c=>rows.some(r=>r.day===c.day)):undefined}/>
        <label className="form-field">Reading day<select value={selected?.day??""} onChange={e=>setSelected(rows.find(r=>r.day===e.target.value)??null)}><option value="">Choose a point or day</option>{rows.map(r=><option key={r.day} value={r.day}>{r.day}</option>)}</select></label>
        {selected&&<div className="stack" data-testid="reading-detail"><p>{selected.day}: {selected[config.field]??"No reading"} {config.unit}{metric==="BP"?" · Diastolic "+(selected.bp_diastolic??"—")+" mmHg":""}</p>
          {selected.contains_sample&&<span className="badge">Sample data</span>}<p className="muted">Source device: {activeSource?(device?.id===activeSource?device.label:"Loading…"):"Not available"}</p>
          <p className="muted">One source per metric per day is selected. Real readings take priority, then coverage. A day split between devices may be undercounted.</p>
        </div>}
      </>}
      {metric==="Temp"&&<><p className="muted">Cycle shading is an estimate for planning training and energy, not fertility or contraception.</p>
        {initial.profile.cycle_tracking_enabled?<div className="chips">{cyclePhases.map(phase=><span key={phase} className="badge"><PhaseSwatch phase={phase}/>{phase}</span>)}</div>:<a className="underline" href={"/more/cycle?profile="+userId}>Enable cycle tracking</a>}</>}
      {range==="All"&&<p className="muted">All history is available in pages of up to 365 recorded days. This page has {rows.length} days. Older history is never discarded.</p>}
      {range==="All"&&view.next_cursor&&<button className="button secondary" disabled={busy} onClick={()=>void load("All",view.next_cursor)}>Earlier history</button>}
      {range==="All"&&<button className="button secondary" disabled={busy} onClick={()=>void load("All")}>Latest history</button>}
    </section>
    {view.can_read_alerts&&(view.markers?.length??0)>0&&<section className="card stack"><h2 className="type-section">Unusual readings</h2><p className="muted">Markers remain here after acknowledgement.</p><div className="chips">{(view.markers??[]).filter(m=>rows.some(r=>r.day===m.day)).map(m=><button key={m.day} disabled={busy} onClick={()=>void showAlerts(m.day)}>{m.day} · {m.count}{m.acknowledged?" · acknowledged":""}</button>)}</div>
      {alerts?.alerts?.map(a=><article key={a.id} className="stack border-t border-rule pt-4">{a.is_sample&&<span className="badge">Sample data</span>}<p>{a.metric_snapshot.body}</p><p className="muted">{a.acknowledged_at?"Acknowledged":"Unacknowledged"} · {a.severity}</p></article>)}
      {alerts?.next_cursor&&alertDay&&<button className="button secondary" disabled={busy} onClick={()=>void showAlerts(alertDay,alerts.next_cursor)}>More readings for this day</button>}
    </section>}
    <section className="card stack"><h2 className="type-section">Documents</h2>{!docs?<p>Loading documents…</p>:docs.documents?.length?docs.documents.map(d=><div key={d.id} className="list-row"><a href={"/api/documents/"+d.id} className="underline">{d.title}<span className="block muted">{d.type.replaceAll("_"," ")} · Download</span></a></div>):<p className="muted">No documents added.</p>}
      {docs?.next_cursor&&<button className="button secondary" onClick={()=>{void readView(userId,"documents",{cursor:docs.next_cursor}).then(setDocs).catch(()=>setError("Could not load documents. Try again."));}}>More documents</button>}
      {initial.can_manage&&<DocumentUpload userId={userId} onUploaded={async()=>setDocs(await readView(userId,"documents"))}/>}
    </section>
    {error&&<p role="alert">{error}</p>}
  </div>;
}
