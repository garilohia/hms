"use client";
import {useState} from "react";
import {z} from "zod";
import {carePost} from "@/src/lib/care/model";
import {clinicalSnapshotSchema,clinicalMetrics,clinicalNumber,clinicalTrend} from "@/src/lib/care/clinical-model";
import {DataChart} from "../ui/chart";
export function ClinicalSummary({initial,owner}:{initial:z.infer<typeof clinicalSnapshotSchema>;owner:boolean}) {
  const [snapshot,setSnapshot]=useState(initial),[busy,setBusy]=useState(false),[status,setStatus]=useState(""),[medications,setMedications]=useState(initial.body.medications.join("\n"));
  const body=snapshot.body;
  async function refresh(days:30|90,create=false) {
    setBusy(true);setStatus("");try{setSnapshot(clinicalSnapshotSchema.parse(await carePost({kind:"summary",userId:body.profile.id,days,create})));if(create)setStatus("Snapshot saved. The download link now uses this frozen summary.");}
    catch(error){setStatus(error instanceof Error?error.message:"Summary unavailable.");}finally{setBusy(false);}
  }
  async function saveMedications() {
    setBusy(true);setStatus("");try{await carePost({kind:"medications",userId:body.profile.id,items:medications.split("\n").map(v=>v.trim()).filter(Boolean)});
      setSnapshot(clinicalSnapshotSchema.parse(await carePost({kind:"summary",userId:body.profile.id,days:body.days})));setStatus("Reported medications saved. Existing snapshots are unchanged.");}
    catch(error){setStatus(error instanceof Error?error.message:"Could not save the list.");}finally{setBusy(false);}
  }
  return <div className="stack"><section className="card stack"><h2>{body.profile.name}</h2><p>DOB {body.profile.dob}. {body.profile.sex_at_birth||"Sex not recorded"}</p>
    {body.contains_sample&&<p className="sample-badge">Sample data</p>}{body.consent_given_by_guardian&&<p className="sample-badge">Consent given by guardian</p>}
    <p className="muted">{body.from} to {body.to}, {body.profile.timezone}</p><div className="chips">{([30,90] as const).map(days=><button key={days} className="chip" aria-pressed={body.days===days} disabled={busy} onClick={()=>refresh(days)}>{days} days</button>)}</div>
    {owner&&<button className="button secondary" disabled={busy} onClick={()=>refresh(body.days,true)}>Save current summary snapshot</button>}
    <a className="button" href={"/api/clinical-summary?profile="+body.profile.id+"&days="+body.days+(snapshot.id?"&snapshot="+snapshot.id:"")}>Download clinical PDF</a>
    <p className="muted">Downloads cannot be remotely revoked. Share only with people you choose.</p><p role="status">{status}</p>
  </section>
  {clinicalMetrics.map(metric=>{const trend=clinicalTrend(body,metric.key);return <section key={metric.key} className="card stack"><h2>{metric.label}</h2><p>Daily mean {clinicalNumber(trend.mean)} {metric.unit}, {trend.n} of {body.days} recorded days</p>
    {trend.n>0&&<DataChart sparkline height={56} kind="line" label={metric.label} unit={metric.unit} values={body.series.map(row=>({day:row.day,value:row[metric.key]}))}/>}
    {metric.key==="bp_systolic"&&<p className="muted">Diastolic mean {clinicalNumber(clinicalTrend(body,"bp_diastolic").mean)} mmHg</p>}</section>;})}
  <section className="card stack"><h2>Unusual readings</h2><p>{body.alert_counts.length?body.alert_counts.map(a=>a.severity+": "+a.count).join(", "):"No recorded alerts in this period."}</p></section>
  <section className="card stack"><h2>Reported medications</h2>{body.medications.length?<ul>{body.medications.map((m,i)=><li key={i}>{m}</li>)}</ul>:<p className="muted">Not recorded. This does not mean none are taken.</p>}
    {owner&&<><label>Your current list (one per line, up to 12)<textarea value={medications} onChange={e=>setMedications(e.target.value)} maxLength={1452}/></label><p className="muted">Report what you currently take. This is not a recommendation. Processing consent must be on in Devices &amp; data.</p><button className="button secondary" disabled={busy} onClick={saveMedications}>Save reported medications</button></>}
  </section><section className="card stack"><h2>Documents and prescriptions</h2>{body.documents.length?body.documents.map(d=><p key={d.id}>{d.title}, {d.type.replaceAll("_"," ")}</p>):<p>No documents recorded.</p>}
    {body.document_count>body.documents.length&&<p>{body.documents.length} most recent of {body.document_count}. The full list is in History for authorised full-history viewers.</p>}</section>
  <p className="muted">{body.disclaimer} Discuss with your doctor. Charts use separate scales and break at missing dates.</p></div>;
}
