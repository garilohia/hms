"use client";
import { useEffect,useState } from "react";
import { readView,type PatientView } from "@/src/lib/patient/model";
export function Records({userId,section}:{userId:string;section:"raw"|"sources"}) {
  const [view,setView]=useState<PatientView|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{const controller=new AbortController();void readView(userId,section,{signal:controller.signal}).then(setView).catch(()=>{if(!controller.signal.aborted)setError("Could not load these records. Refresh to retry.");});return()=>controller.abort();},[userId,section]);
  async function next(){setBusy(true);setError("");try{setView(await readView(userId,section,{cursor:view?.next_cursor}));}catch{setError("Could not load the next page. Try again.");}finally{setBusy(false);}}
  return <section className="card stack"><h2 className="type-section">{section==="raw"?"Raw metric records":"Connected sources"}</h2>
    {!view&&!error&&<p>Loading…</p>}
    {view&&section==="raw"&&((view.metrics??[]).length?view.metrics?.map(m=><div className="list-row" key={m.id}><div>{m.provider==="simulator"&&<span className="badge">Sample data</span>}<p>{m.metric_type.replaceAll("_"," ")}: {m.value} {m.unit}</p><p className="muted">{new Date(m.recorded_at).toLocaleString("en-GB",{timeZone:view.profile.timezone})}, {String(m.metadata.label??m.provider)}</p></div></div>):<p>No readings on this page.</p>)}
    {view&&section==="sources"&&((view.sources??[]).length?view.sources?.map(s=><div className="list-row" key={s.id}><div>{s.provider==="simulator"&&<span className="badge">Sample data</span>}<p>{String(s.metadata.label??s.provider)}</p><p className="muted">{s.status}, {s.last_sync_at?"Last import "+s.last_sync_at.slice(0,10):"No readings imported yet"}</p></div></div>):<p>No connected sources.</p>)}
    {view?.next_cursor&&<button disabled={busy} className="button secondary" onClick={()=>void next()}>Next page</button>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
