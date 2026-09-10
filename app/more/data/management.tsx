"use client";
import {useCallback,useState} from "react";
import {patientPost,type PatientProfile} from "@/src/lib/patient/model";
import {Records} from "../records";
import {DataImport} from "./upload";
import {WearableConnections} from "./connections";
import type {IntegrationStatus} from "@/src/lib/integrations/model";
export function DataManagement({profile,connections}:{profile:PatientProfile;connections:IntegrationStatus[]}) {
  const [busy,setBusy]=useState(false),[saving,setSaving]=useState(false),[message,setMessage]=useState(""),[version,setVersion]=useState(0),[sourceVersion,setSourceVersion]=useState(0);
  const imported=useCallback(()=>setSourceVersion(n=>n+1),[]);
  async function withdraw(){setSaving(true);setMessage("");try{await patientPost("/api/consents",{userId:profile.id,type:"data_ingestion",grant:false});setVersion(n=>n+1);setMessage("Processing consent withdrawn. New imports, recomputations and notifications are paused. Existing history is retained.");}catch{setMessage("Could not withdraw consent. Please retry.");}finally{setSaving(false);}}
  return <><WearableConnections profileId={profile.id} initial={connections}/><Records key={"records:"+sourceVersion} userId={profile.id} section="sources"/><div id="health-import"><DataImport key={"import:"+version} profiles={[profile]} onBusyChange={setBusy} onComplete={imported}/></div>
    <section className="card stack"><h2 className="font-semibold">Processing consent</h2><p className="muted">You can pause processing without removing your saved history. To resume, give consent again in the import form.</p><button className="button secondary" disabled={busy||saving} onClick={()=>void withdraw()}>Withdraw processing consent</button>{message&&<p role="status">{message}</p>}</section>
  </>;
}
