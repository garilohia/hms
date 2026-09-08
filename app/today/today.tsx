"use client";
import { useEffect,useState } from "react";
import { patientPost,readView,type PatientView } from "@/src/lib/patient/model";
export function Today({initial}:{initial:PatientView}) {
  const [view,setView]=useState(initial),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
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
  },[initial,userId]);
  const summary=view.summaries?.[0],alert=view.alerts?.[0];
  async function acknowledge() {
    if(!alert) return;
    setBusy(true);setMessage("");
    try {await patientPost("/api/alerts/settings",{userId,action:"acknowledge",payload:{alertId:alert.id}});setView(await readView(userId,"today"));}
    catch(error){setMessage(error instanceof Error?error.message:"Please try again.");} finally{setBusy(false);}
  }
  return <div className="stack">
    <section className={"card hero stack "+(alert?.severity||"")} data-testid="today-hero">
      {(view.contains_sample || alert?.is_sample) && <span className="badge">Sample data</span>}
      {view.consent_given_by_guardian && <p className="muted">Consent given by guardian</p>}
      {alert?<>
        <h2 className="text-xl font-semibold capitalize">{alert.severity} reading</h2>
        <p>{alert.metric_snapshot.body}</p>
        {alert.is_historical && <p className="muted">Historical sample event. No external notification was sent.</p>}
        {view.can_manage?<button className="button secondary" disabled={busy} onClick={()=>void acknowledge()}>Acknowledge reading</button>:<p className="muted">Read-only shared view</p>}
        {(view.active_alert_count??0)>1 && <p className="muted">{view.active_alert_count} unacknowledged readings. The highest priority is shown first.</p>}
      </>:summary?<>
        <h2 className="text-lg">Your readiness</h2><p className="hero-score">{summary.readiness_score??"—"}<span className="text-lg tracking-normal">{summary.readiness_score!==null?" / 100":""}</span></p>
        <p>{summary.readiness_score===null?"A score needs resting heart rate, HRV and sleep, with at least seven prior days for each.":"A guide to your recent recovery. Not a medical assessment."}</p>
        <p className="muted">Latest readings: {summary.day}. Resting HR {summary.rhr??"—"} bpm · HRV {summary.hrv_avg===null?"—":Math.round(summary.hrv_avg)} ms · Sleep {summary.sleep_duration_min===null?"—":(summary.sleep_duration_min/60).toFixed(1)} h.</p>
        <a className="underline text-sm" href={"/more/advanced?profile="+userId}>How this score works</a>
      </>:<><h2 className="text-2xl font-semibold">Your history starts here.</h2><p>Import your readings or explore clearly labelled sample data.</p>{view.can_manage&&<a className="button secondary" href={"/more/data?profile="+userId}>Connect data</a>}</>}
      {message&&<p role="status" className="muted">{message}</p>}
    </section>
    {(view.insights??[]).slice(0,3).map(insight=><article className="card insight stack" key={insight.id} data-testid="insight-card">
      {view.contains_sample&&<span className="badge">Sample data</span>}<h2>{insight.title}</h2><p>{insight.body}</p><p className="muted">Confidence: {insight.confidence}.</p>
      <footer><a className="underline" href="/legal/disclaimer">Discuss with your doctor.</a></footer>
    </article>)}
    <a className="button" href={"/doctors?profile="+userId}>Talk to a doctor</a>
  </div>;
}
