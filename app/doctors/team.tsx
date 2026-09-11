"use client";
import {useRef,useState,type FormEvent} from "react";
import {RetryIds} from "@/src/lib/care/retry";
import {z} from "zod";
import {carePost,doctorSchema,linkSchema,listSchema,consultRowSchema} from "@/src/lib/care/model";
import {patientPost} from "@/src/lib/patient/model";
type Directory=z.infer<ReturnType<typeof listSchema<typeof doctorSchema>>>;
type Links=z.infer<ReturnType<typeof listSchema<typeof linkSchema>>>;
type Consults=z.infer<ReturnType<typeof listSchema<typeof consultRowSchema>>>;
export function DoctorTeam({userId,initialDirectory,initialLinks,initialConsults}:{userId:string;initialDirectory:Directory;initialLinks:Links;initialConsults:Consults}) {
  const requestIds=useRef(new RetryIds());
  const [directory,setDirectory]=useState(initialDirectory),[links,setLinks]=useState(initialLinks),[consults,setConsults]=useState(initialConsults),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState("");
  async function reload() {setLinks(listSchema(linkSchema).parse(await carePost({kind:"list",section:"doctors",userId})));setConsults(listSchema(consultRowSchema).parse(await carePost({kind:"consult_list",userId})));}
  async function link(event:FormEvent<HTMLFormElement>,doctorId:string) {
    event.preventDefault();setBusy(true);setStatus("");const form=new FormData(event.currentTarget);
    try {if(!consent)throw new Error("Give sharing consent before linking a doctor.");
      await patientPost("/api/consents",{userId,type:"doctor_sharing",grant:true});
      await carePost({kind:"sharing",userId,action:"link_doctor",data:{partnerId:doctorId,scopes:[form.get("scope"),...(form.get("alerts")==="on"?["alerts"]:[])]}});
      await reload();setStatus("Doctor linked with your chosen scope.");}
    catch(e){setStatus(e instanceof Error?e.message:"Could not link doctor.");}finally{setBusy(false);}
  }
  async function revoke(linkId:string) {setBusy(true);setStatus("");try{await carePost({kind:"sharing",userId,action:"revoke_doctor",data:{linkId}});await reload();setStatus("Access revoked. Open consult requests with this doctor are cancelled.");}catch(e){setStatus(e instanceof Error?e.message:"Could not revoke.");}finally{setBusy(false);}}
  async function request(event:FormEvent<HTMLFormElement>,doctorId:string) {
    event.preventDefault();setBusy(true);setStatus("");const form=new FormData(event.currentTarget);
    const data={doctorId,type:form.get("type"),note:form.get("note"),days:30};
    const requestId=requestIds.current.id(userId+":"+doctorId,JSON.stringify(data));
    try {const id=z.uuid().parse(await carePost({kind:"consult",userId,action:"request",data:{...data,requestId}}));
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Full private navigation rechecks current access.
      window.location.href="/consults/"+id;}
    catch(e){setStatus((e instanceof Error?e.message:"Request failed.")+" The request may have saved. Retry unchanged details, or check Consults before starting another request.");setBusy(false);}
  }
  async function next(section:"directory"|"doctors"|"consults") {setBusy(true);try{
    if(section==="directory")setDirectory(listSchema(doctorSchema).parse(await carePost({kind:"list",section,cursor:directory.next_cursor})));
    if(section==="doctors")setLinks(listSchema(linkSchema).parse(await carePost({kind:"list",section,userId,cursor:links.next_cursor})));
    if(section==="consults")setConsults(listSchema(consultRowSchema).parse(await carePost({kind:"consult_list",userId,cursor:consults.next_cursor})));
  }catch(e){setStatus(e instanceof Error?e.message:"Could not load more.");}finally{setBusy(false);}}
  return <div className="stack"><a className="button secondary" href={"/summary?profile="+userId}>Your clinical summary</a>
    <section className="card stack"><h2>Your doctors</h2>{links.rows.length?links.rows.map(l=><div key={l.id} className="stack"><h3>{l.name}</h3>{l.is_sample&&<span className="sample-badge">Sample data</span>}<p>{l.status}. Scope: {l.granted_scopes.join(", ")}</p>
      {l.status==="active"&&<><button className="button secondary" disabled={busy} onClick={()=>revoke(l.id)}>Revoke {l.name}</button>
        <form className="stack" onSubmit={e=>request(e,l.doctor_id!)}><label>Review type<select name="type" defaultValue="trend_review"><option value="trend_review">Trend review</option><option value="urgent_review">Urgent review</option><option value="second_opinion">Second opinion</option><option value="follow_up">Follow-up</option></select></label>
          <label>Optional note<textarea name="note" maxLength={4000}/></label><p className="muted">Attaches a current 30-day summary. No immediate response is guaranteed. Appointment time is agreed after acceptance.</p><button className="button" disabled={busy||!l.verified_at}>Request review</button></form></>}
    </div>):<p className="muted">No linked doctors yet.</p>}{links.next_cursor&&<button className="button secondary" disabled={busy} onClick={()=>next("doctors")}>Next linked doctors</button>}</section>
    <section className="card stack"><h2>Consults</h2>{consults.rows.length?consults.rows.map(c=><a className="list-row" key={c.id} href={"/consults/"+c.id}>{c.doctor_name}, {c.type.replaceAll("_"," ")}, {c.status}</a>):<p className="muted">No consults yet.</p>}{consults.next_cursor&&<button className="button secondary" disabled={busy} onClick={()=>next("consults")}>Earlier consults</button>}</section>
    <section className="card stack"><h2>Find a doctor</h2><label className="check-label"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>I consent to sharing this profile with the doctors I choose, within each selected scope. I can revoke access.</label>
      {directory.rows.length?directory.rows.map(d=><article key={d.id} className="stack"><h3>{d.name}</h3>{d.is_sample&&<p className="sample-badge">Sample data. Fictional practitioner. No real consultation.</p>}<p>{d.specialities.join(", ")}. Languages: {d.languages.join(", ")}</p><p>{d.bio}</p>
        <p>INR {d.consult_fee_inr} / USD {d.consult_fee_usd}. {d.available?"Taking requests; time agreed after acceptance":"Not taking requests"}</p>
        <form className="stack" onSubmit={e=>link(e,d.id)}><label>Sharing scope<select name="scope"><option value="summary_only">Summary only</option><option value="full_history">Full history</option></select></label><label className="check-label"><input type="checkbox" name="alerts"/>Also share the detailed alerts feed</label><button className="button secondary" disabled={busy||!consent}>Link {d.name}</button></form>
      </article>):<p className="muted">No verified doctors available yet.</p>}{directory.next_cursor&&<button className="button secondary" disabled={busy} onClick={()=>next("directory")}>More doctors</button>}</section>
    <p role="status">{status}</p><p className="muted">Not for emergencies. If you feel unwell, contact your doctor or local emergency services.</p></div>;
}
