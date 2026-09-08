"use client";
import { useState,type FormEvent } from "react";
import { patientPost,type PatientView } from "@/src/lib/patient/model";
export function CycleSettings({view}:{view:PatientView}) {
  const [enabled,setEnabled]=useState(view.profile.cycle_tracking_enabled),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  async function save(action:string,payload:unknown){setBusy(true);setMessage("");try{await patientPost("/api/profiles/settings",{userId:view.profile.id,action,payload});setMessage(action==="period"?"Period saved. Your estimates will update with your summary.":"Preference saved.");return true;}catch(e){setMessage(e instanceof Error?e.message:"Please try again.");return false;}finally{setBusy(false);}}
  async function period(event:FormEvent<HTMLFormElement>){event.preventDefault();await save("period",Object.fromEntries(new FormData(event.currentTarget)));}
  return <div className="card stack"><p>Estimates for planning training and energy. Not suitable for fertility prediction or contraception. A logged period anchors the estimate.</p>
    <label className="check-field"><input type="checkbox" checked={enabled} disabled={busy||!view.can_manage} onChange={async e=>{const value=e.target.checked;setEnabled(value);if(!await save("cycle",{enabled:value}))setEnabled(!value);}}/><span>Show cycle estimates</span></label>
    <p className="muted">Turning this off hides cycle insights and shading. Your recorded history is retained. Importing menstrual flow also records period anchors when you have given ingestion consent.</p>
    {view.can_manage&&enabled&&<form className="stack" onSubmit={period}><label className="form-field">Period start<input type="date" name="start" required/></label><label className="form-field">Period end (optional)<input type="date" name="end"/></label><button disabled={busy||!view.ingestion_consent} className="button">Save period</button>{!view.ingestion_consent&&<a className="underline" href={"/more/data?profile="+view.profile.id}>Give ingestion consent before recording a period</a>}</form>}
    {message&&<p role="status">{message}</p>}
  </div>;
}
