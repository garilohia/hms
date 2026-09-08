"use client";
import { useEffect,useState } from "react";
import { z } from "zod";
import { addDays } from "@/src/lib/analytics/time";
import { chartMetrics,chartSeries,type ChartMetric } from "@/src/lib/patient/chart";
import { patientPost,readView,type PatientView,type Summary } from "@/src/lib/patient/model";
import {DocumentUpload} from "./document-upload";
const phaseColours:Record<string,string>={menstrual:"#f4c2ca",follicular:"#c0eae0",ovulatory:"#efd695",luteal:"#d9d2f1"};
export function History({initial,today}:{initial:PatientView;today:string}) {
  const [view,setView]=useState(initial),[metric,setMetric]=useState<ChartMetric>("RHR"),[range,setRange]=useState("90"),[selected,setSelected]=useState<Summary|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [device,setDevice]=useState<{id:string;label:string}|null>(null),[docs,setDocs]=useState<PatientView|null>(null),[alerts,setAlerts]=useState<PatientView|null>(null),[alertDay,setAlertDay]=useState<string|null>(null);
  const userId=initial.profile.id;
  useEffect(()=>{const controller=new AbortController();
    void readView(userId,"documents",{signal:controller.signal}).then(setDocs).catch(()=>{if(!controller.signal.aborted)setError("Document details could not load. Refresh to retry.");});
    return()=>controller.abort();},[userId]);
  const from=range==="All"?null:addDays(today,1-Number(range));
  const rows=(view.summaries??[]).filter(r=>!from||r.day>=from);
  const series=chartSeries(rows,metric),config=chartMetrics[metric];
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
    try {const next=await readView(userId,"history",{from:nextRange==="All"?null:addDays(today,1-Number(nextRange)),to:today,cursor});setView(next);setRange(nextRange);setSelected(null);setAlerts(null);}
    catch(e){setError(e instanceof Error?e.message:"Please try again.");}finally{setBusy(false);}
  }
  async function showAlerts(day:string,cursor?:Record<string,string>|null) {
    setBusy(true);setError("");
    try{setAlerts(await readView(userId,"alerts",{from:day,to:day,cursor}));setAlertDay(day);}catch(e){setError(e instanceof Error?e.message:"Please try again.");}finally{setBusy(false);}
  }
  return <div className="stack">
    <div aria-label="Metric" className="chips">{Object.keys(chartMetrics).map(key=><button key={key} aria-pressed={metric===key} onClick={()=>{setMetric(key as ChartMetric);setSelected(null);}}>{key}</button>)}</div>
    <div aria-label="History range" className="chips">{["7","30","90","365","All"].map(value=><button disabled={busy} key={value} aria-pressed={range===value} onClick={()=>void load(value)}>{value==="All"?"All":value+" days"}</button>)}</div>
    <section className="card stack">
      {rows.some(r=>r.contains_sample)&&<span className="badge">Sample data</span>}
      <h2 className="font-semibold">{metric} <span className="muted">{config.unit}</span></h2>
      {metric==="BP"&&<p className="muted">Systolic trend. Select a day for both blood pressure readings.</p>}
      {!rows.length?<p>No readings in this range. Try a longer range or connect data.</p>:<>
        <svg className="data-chart" viewBox="0 0 600 250" role="img" aria-label={metric+" history chart"} onPointerDown={event=>{
          const box=event.currentTarget.getBoundingClientRect(),x=(event.clientX-box.left)*600/box.width;
          if(x<40||x>570)return;
          const nearest=series.points.filter(p=>p.y!==null).reduce<typeof series.points[number]|null>((best,p)=>!best||Math.abs(p.x-x)<Math.abs(best.x-x)?p:best,null);
          if(nearest)setSelected(nearest.row);
        }}>
          <title>{metric+" daily history. Gaps mean missing readings. Use the day picker below for values and source details."}</title>
          {metric==="Temp"&&initial.profile.cycle_tracking_enabled&&(view.cycles??[]).filter(c=>phaseColours[c.phase]&&rows.some(r=>r.day===c.day)).map(c=><rect key={c.day} data-testid="cycle-phase" x={Math.max(40,series.x(c.day)-2)} y={25} width={Math.max(3,520/Math.max(1,rows.length))} height={175} fill={phaseColours[c.phase]}><title>{c.day+": "+c.phase+" estimate ("+c.confidence+")"}</title></rect>)}
          <line x1="40" y1="200" x2="570" y2="200" stroke="#c9d5df"/>
          <text x="4" y="40">{series.max.toFixed(1)}</text><text x="4" y="197">{series.min.toFixed(1)}</text>
          {series.segments.map((path,i)=><path key={i} d={path} stroke="#006c68" strokeWidth="2.5" fill="none"/>)}
          {series.points.filter(p=>p.y!==null).map(p=><circle className="chart-point" key={p.row.day} role="button" aria-label={"Reading "+p.row.day} cx={p.x} cy={p.y!} r={4} fill="#006c68" stroke="white" strokeWidth={1} onClick={()=>setSelected(p.row)}><title>{p.row.day+": "+p.value+" "+config.unit}</title></circle>)}
          {(view.markers??[]).filter(m=>rows.some(r=>r.day===m.day)).map(m=><g key={m.day} data-testid="alert-marker" data-acknowledged={m.acknowledged} role="button" aria-label={"Alerts "+m.day} onClick={()=>void showAlerts(m.day)}><circle cx={series.x(m.day)} cy={214} r={6} fill={m.acknowledged?"#687989":"#b35024"}/><title>{m.count+" unusual readings on "+m.day}</title></g>)}
          <text x="44" y="241">{series.points[0]?.row.day}</text><text x="565" y="241" textAnchor="end">{series.points.at(-1)?.row.day}</text>
        </svg>
        <label className="form-field">Reading day<select value={selected?.day??""} onChange={e=>setSelected(rows.find(r=>r.day===e.target.value)??null)}><option value="">Choose a point or day</option>{rows.map(r=><option key={r.day} value={r.day}>{r.day}</option>)}</select></label>
        {selected&&<div className="stack" data-testid="reading-detail"><p>{selected.day}: {selected[config.field]??"No reading"} {config.unit}{metric==="BP"?" · Diastolic "+(selected.bp_diastolic??"—")+" mmHg":""}</p>
          {selected.contains_sample&&<span className="badge">Sample data</span>}<p className="muted">Source device: {activeSource?(device?.id===activeSource?device.label:"Loading…"):"Not available"}</p>
          <p className="muted">One source per metric per day is selected. Real readings take priority, then coverage. A day split between devices may be undercounted.</p>
        </div>}
      </>}
      {metric==="Temp"&&<><p className="muted">Cycle shading is an estimate for planning training and energy, not fertility or contraception.</p>
        {initial.profile.cycle_tracking_enabled?<div className="chips">{Object.entries(phaseColours).map(([phase,colour])=><span key={phase} className="badge" style={{background:colour}}>{phase}</span>)}</div>:<a className="underline" href={"/more/cycle?profile="+userId}>Enable cycle tracking</a>}</>}
      {range==="All"&&<p className="muted">All history is available in pages of up to 365 recorded days. This page has {rows.length} days. Older history is never discarded.</p>}
      {range==="All"&&view.next_cursor&&<button className="button secondary" disabled={busy} onClick={()=>void load("All",view.next_cursor)}>Earlier history</button>}
      {range==="All"&&<button className="button secondary" disabled={busy} onClick={()=>void load("All")}>Latest history</button>}
    </section>
    {view.can_read_alerts&&(view.markers?.length??0)>0&&<section className="card stack"><h2 className="font-semibold">Unusual readings</h2><p className="muted">Markers remain here after acknowledgement.</p><div className="chips">{(view.markers??[]).filter(m=>rows.some(r=>r.day===m.day)).map(m=><button key={m.day} disabled={busy} onClick={()=>void showAlerts(m.day)}>{m.day} · {m.count}{m.acknowledged?" · acknowledged":""}</button>)}</div>
      {alerts?.alerts?.map(a=><article key={a.id} className="stack border-t border-slate-200 pt-4">{a.is_sample&&<span className="badge">Sample data</span>}<p>{a.metric_snapshot.body}</p><p className="muted">{a.acknowledged_at?"Acknowledged":"Unacknowledged"} · {a.severity}</p></article>)}
      {alerts?.next_cursor&&alertDay&&<button className="button secondary" disabled={busy} onClick={()=>void showAlerts(alertDay,alerts.next_cursor)}>More readings for this day</button>}
    </section>}
    <section className="card stack"><h2 className="text-lg font-semibold">Documents</h2>{!docs?<p>Loading documents…</p>:docs.documents?.length?docs.documents.map(d=><div key={d.id} className="list-row"><a href={"/api/documents/"+d.id} className="underline">{d.title}<span className="block muted">{d.type.replaceAll("_"," ")} · Download</span></a></div>):<p className="muted">No documents added.</p>}
      {docs?.next_cursor&&<button className="button secondary" onClick={()=>{void readView(userId,"documents",{cursor:docs.next_cursor}).then(setDocs).catch(()=>setError("Could not load documents. Try again."));}}>More documents</button>}
      {initial.can_manage&&<DocumentUpload userId={userId} onUploaded={async()=>setDocs(await readView(userId,"documents"))}/>}
    </section>
    {error&&<p role="alert">{error}</p>}
  </div>;
}
