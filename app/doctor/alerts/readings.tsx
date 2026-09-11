"use client";
import {useState} from "react";
import {readView,type PatientView} from "@/src/lib/patient/model";
import {AlertIcon} from "../../ui/icons";
export function SharedAlerts({initial}:{initial:PatientView}) {
  const [view,setView]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function load(earlier:boolean) {setBusy(true);setError("");try{setView(await readView(view.profile.id,"alerts",{cursor:earlier?view.next_cursor:null}));}catch(e){setError(e instanceof Error?e.message:"Readings unavailable.");}finally{setBusy(false);}}
  return <div className="stack"><p className="muted">Read-only. Only the patient or owning guardian can acknowledge readings.</p>
    {view.alerts?.length?view.alerts.map(a=><section className={"card stack "+(a.severity==="urgent"?"alert-urgent":"alert-attention")} key={a.id}>{a.is_sample&&<span className="sample-badge">Sample data</span>}
      <div className="alert-label"><AlertIcon severity={a.severity}/><h2 className="sentence">{a.severity} reading</h2></div>
      <p>{a.metric_snapshot.body}</p><p className="muted">{a.acknowledged_at?"Acknowledged":"Not acknowledged"}</p></section>):<p>No recorded alerts.</p>}
    <p role="status">{error}</p><button className="button secondary" disabled={busy} onClick={()=>load(false)}>Latest readings</button>{view.next_cursor&&<button className="button secondary" disabled={busy} onClick={()=>load(true)}>Earlier readings</button>}</div>;
}
