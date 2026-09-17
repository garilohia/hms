"use client";
import { useEffect,useState } from "react";
import { z } from "zod";
import { addDays } from "@/src/lib/analytics/time";
import { BAND_MADS,BASELINE_WINDOW_DAYS,buildSeries,chartMetrics,formatValue,summaryValues,type ChartMetric } from "@/src/lib/patient/chart";
import { patientPost,readView,type PatientView,type Summary } from "@/src/lib/patient/model";
import { DataChart,PhaseSwatch,cyclePhases } from "../ui/chart";
import { RebucketNotice,StaleDay } from "../ui/rebucket";
import {DocumentUpload} from "./document-upload";
import {useRealtimePatientView} from "@/src/lib/patient/realtime";
// The band needs the 28 days before the visible range, so every loaded row is kept as baseline source.
function mergeRows(previous:Summary[],next:Summary[]) { const byDay=new Map(previous.map(r=>[r.day,r])); for(const row of next) byDay.set(row.day,row); return [...byDay.values()]; }
export function History({initial,today}:{initial:PatientView;today:string}) {
  const {view,setView,live}=useRealtimePatientView(initial,"history");
  const [metric,setMetric]=useState<ChartMetric>("RHR"),[range,setRange]=useState("90"),[selected,setSelected]=useState<Summary|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [baselineRows,setBaselineRows]=useState<Summary[]>(initial.summaries??[]);
  const mode=initial.profile.display_mode;
  // Advanced: up to three overlaid metrics, told apart by weight and dash (DESIGN.md §9).
  const [overlays,setOverlays]=useState<ChartMetric[]>([]);
  const [sourceLabels,setSourceLabels]=useState<Record<string,string>>({});
  const [showAllRows,setShowAllRows]=useState(false);
  const [device,setDevice]=useState<{id:string;label:string}|null>(null),[docs,setDocs]=useState<PatientView|null>(null),[alerts,setAlerts]=useState<PatientView|null>(null),[alertDay,setAlertDay]=useState<string|null>(null);
  const userId=initial.profile.id;
  useEffect(()=>{const controller=new AbortController();
    void readView(userId,"documents",{signal:controller.signal}).then(setDocs).catch(()=>{if(!controller.signal.aborted)setError("Document details could not load. Refresh to retry.");});
    return()=>controller.abort();},[userId]);
  const from=range==="All"?null:addDays(today,1-Number(range));
  const rows=(view.summaries??[]).filter(r=>!from||r.day>=from);
  const config=chartMetrics[metric];
  const stale=new Set(view.stale_days??[]);
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
  // Advanced raw table: resolve each source once through the existing audited lookup.
  const sourceIds=mode==="advanced"?[...new Set(rows.map(r=>r.source_ids[config.source]).filter((id):id is string=>Boolean(id)))]:[];
  const missingSources=sourceIds.filter(id=>!(id in sourceLabels)).join(",");
  useEffect(()=>{
    if(!missingSources) return;
    const controller=new AbortController();
    void Promise.all(missingSources.split(",").map(async id=>{
      try { const source=z.object({label:z.string().nullable(),provider:z.string()}).parse(await patientPost("/api/patient/source",{userId,sourceId:id},controller.signal)); return [id,source.label??source.provider] as const; }
      catch { return [id,"Source unavailable"] as const; }
    })).then(entries=>{ if(!controller.signal.aborted) setSourceLabels(previous=>({...previous,...Object.fromEntries(entries)})); });
    return()=>controller.abort();
  },[missingSources,userId]);
  const advancedSeries=mode==="advanced"&&rows.length?buildSeries(summaryValues(rows,metric),{kind:config.kind,baseline:summaryValues(baselineRows,metric)}):null;
  if(mode==="simple") return <div className="stack" data-testid="patient-live-state" data-live={live}>
    {(Object.keys(chartMetrics) as ChartMetric[]).map(key=>{const c=chartMetrics[key],values=summaryValues(rows,key),latest=[...values].reverse().find(v=>v.value!==null);
      return <section key={key} className="card metric-card">{rows.some(r=>r.contains_sample)&&key==="RHR"&&<span className="badge">Sample data</span>}
        <p className="metric-label"><span>{c.label}</span></p>
        <p className="hero-figure"><span className="hero-score">{latest?formatValue(latest.value!):"—"}</span><span className="unit">{c.unit}</span></p>
        {latest?<DataChart sparkline values={values} baseline={summaryValues(baselineRows,key)} kind={c.kind} label={c.label} unit={c.unit} height={56}/>:<p className="muted">No readings in the last 90 days.</p>}
      </section>;})}
    <section className="card stack"><h2 className="type-section">Documents</h2>{!docs?<p>Loading documents…</p>:docs.documents?.length?docs.documents.map(d=><div key={d.id} className="list-row"><a href={"/api/documents/"+d.id} className="underline">{d.title}<span className="block muted">{d.type.replaceAll("_"," ")}. Download</span></a></div>):<p className="muted">No documents added.</p>}
      {initial.can_manage&&<DocumentUpload userId={userId} onUploaded={async()=>setDocs(await readView(userId,"documents"))}/>}
    </section>
    {error&&<p role="alert">{error}</p>}
  </div>;
  return <div className="stack" data-testid="patient-live-state" data-live={live}>
    {view.rebucket&&<RebucketNotice state={view.rebucket}/>}
    <div aria-label="Metric" className="chips">{Object.keys(chartMetrics).map(key=><button key={key} aria-pressed={metric===key} onClick={()=>{setMetric(key as ChartMetric);setOverlays(o=>o.filter(v=>v!==key));setSelected(null);}}>{key}</button>)}</div>
    {mode==="advanced"&&<div aria-label="Overlay metrics" className="chips">{(Object.keys(chartMetrics) as ChartMetric[]).filter(key=>key!==metric).map(key=><button key={key} aria-pressed={overlays.includes(key)} disabled={!overlays.includes(key)&&overlays.length>=3} onClick={()=>setOverlays(o=>o.includes(key)?o.filter(v=>v!==key):[...o,key])}>{overlays.includes(key)?"Overlay "+(overlays.indexOf(key)+1)+": "+key:"+ "+key}</button>)}</div>}
    <div aria-label="History range" className="chips">{["7","30","90","365","All"].map(value=><button disabled={busy} key={value} aria-pressed={range===value} onClick={()=>void load(value)}>{value==="All"?"All":value+" days"}</button>)}</div>
    <section className="card stack">
      {rows.some(r=>r.contains_sample)&&<span className="badge">Sample data</span>}
      <h2 className="type-section">{metric} <span className="unit">{config.unit}</span></h2>
      {metric==="BP"&&<p className="muted">Systolic trend. Select a day for both blood pressure readings.</p>}
      {!rows.length?<p>No readings in this range. Try a longer range or connect data.</p>:<>
        <DataChart values={summaryValues(rows,metric)} baseline={summaryValues(baselineRows,metric)} kind={config.kind} label={config.label} unit={config.unit} animate
          markers={(view.markers??[]).filter(m=>rows.some(r=>r.day===m.day))} onMarker={day=>void showAlerts(day)} onPick={day=>setSelected(rows.find(r=>r.day===day)??null)}
          phases={showPhases?(view.cycles??[]).filter(c=>rows.some(r=>r.day===c.day)):undefined}
          overlays={mode==="advanced"?overlays.map(key=>({label:chartMetrics[key].label,values:summaryValues(rows,key)})):undefined}/>
        {mode==="advanced"&&overlays.length>0&&<p className="muted">Overlaid on their own scales: {overlays.map((key,i)=>chartMetrics[key].label+(i===0?" (dashed)":i===1?" (dotted)":" (wide, faint)")).join(", ")}.</p>}
        {advancedSeries&&<div className="panel stack"><p className="type-label">Baseline</p>
          {advancedSeries.lastBand?<p>Usual range {formatValue(advancedSeries.lastBand.low)} to {formatValue(advancedSeries.lastBand.high)} {config.unit}, from {advancedSeries.baselineDays} of {BASELINE_WINDOW_DAYS} days. Latest {formatValue(advancedSeries.last!.value!)} {config.unit}, {advancedSeries.lastOutside?"outside":"inside"} the range.</p>:<p>Fewer than seven days in the last {BASELINE_WINDOW_DAYS}, so no range is computed yet.</p>}
          <details><summary>How the range is computed</summary><p className="muted mt-2">Median of the daily values in the {BASELINE_WINDOW_DAYS} days ending on the latest day, plus and minus {BAND_MADS} times the median absolute deviation. Missing days are skipped, never filled. Alert rules use the same median and deviation with their own multipliers.</p></details>
        </div>}
        {mode==="advanced"&&<div className="panel raw-table-wrap"><table className="raw-table"><caption className="type-label" style={{textAlign:"left",marginBottom:6}}>Daily values with source</caption><thead><tr><th>Day</th><th>{metric}</th>{overlays.map(key=><th key={key}>{key}</th>)}<th>Source</th></tr></thead>
          <tbody>{[...rows].sort((a,b)=>b.day.localeCompare(a.day)).slice(0,showAllRows?365:30).map(r=><tr key={r.day}><td>{r.day} <StaleDay day={r.day} stale={stale}/></td><td>{r[config.field]===null?"—":formatValue(r[config.field] as number)}</td>{overlays.map(key=><td key={key}>{r[chartMetrics[key].field]===null?"—":formatValue(r[chartMetrics[key].field] as number)}</td>)}<td>{r.source_ids[config.source]?sourceLabels[r.source_ids[config.source]]??"Loading…":"—"}</td></tr>)}</tbody></table>
          {rows.length>30&&<button type="button" className="button secondary mt-3" onClick={()=>setShowAllRows(v=>!v)}>{showAllRows?"Show the latest 30 days":"Show all "+rows.length+" days"}</button>}</div>}
        <label className="form-field">Reading day<select value={selected?.day??""} onChange={e=>setSelected(rows.find(r=>r.day===e.target.value)??null)}><option value="">Choose a point or day</option>{rows.map(r=><option key={r.day} value={r.day}>{r.day}</option>)}</select></label>
        {selected&&<div className="stack" data-testid="reading-detail"><p><StaleDay day={selected.day} stale={stale}/></p><p>{selected.day}: {selected[config.field]??"No reading"} {config.unit}{metric==="BP"?", diastolic "+(selected.bp_diastolic??"—")+" mmHg":""}</p>
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
    {view.can_read_alerts&&(view.markers?.length??0)>0&&<section className="card stack"><h2 className="type-section">Unusual readings</h2><p className="muted">Markers remain here after acknowledgement.</p><div className="chips">{(view.markers??[]).filter(m=>rows.some(r=>r.day===m.day)).map(m=><button key={m.day} disabled={busy} onClick={()=>void showAlerts(m.day)}>{m.day}: {m.count} {m.count===1?"reading":"readings"}{m.acknowledged?", acknowledged":""}</button>)}</div>
      {alerts?.alerts?.map(a=><article key={a.id} className="stack border-t border-rule pt-4">{a.is_sample&&<span className="badge">Sample data</span>}<p>{a.metric_snapshot.body}</p><p className="muted">{a.acknowledged_at?"Acknowledged":"Unacknowledged"}, {a.severity}</p></article>)}
      {alerts?.next_cursor&&alertDay&&<button className="button secondary" disabled={busy} onClick={()=>void showAlerts(alertDay,alerts.next_cursor)}>More readings for this day</button>}
    </section>}
    <section className="card stack"><h2 className="type-section">Documents</h2>{!docs?<p>Loading documents…</p>:docs.documents?.length?docs.documents.map(d=><div key={d.id} className="list-row"><a href={"/api/documents/"+d.id} className="underline">{d.title}<span className="block muted">{d.type.replaceAll("_"," ")}. Download</span></a></div>):<p className="muted">No documents added.</p>}
      {docs?.next_cursor&&<button className="button secondary" onClick={()=>{void readView(userId,"documents",{cursor:docs.next_cursor}).then(setDocs).catch(()=>setError("Could not load documents. Try again."));}}>More documents</button>}
      {initial.can_manage&&<DocumentUpload userId={userId} onUploaded={async()=>setDocs(await readView(userId,"documents"))}/>}
    </section>
    {error&&<p role="alert">{error}</p>}
  </div>;
}
