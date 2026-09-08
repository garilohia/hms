"use client";
import {useState,type FormEvent} from "react";
import {z} from "zod";
import {carePost,linkSchema,listSchema} from "@/src/lib/care/model";
import {patientPost,type PatientProfile} from "@/src/lib/patient/model";
type Links=z.infer<ReturnType<typeof listSchema<typeof linkSchema>>>;
export function Family({profile,profiles,accountCode,initialLinks,initialIncoming}:{profile:PatientProfile;profiles:PatientProfile[];accountCode:string;initialLinks:Links;initialIncoming:Links}) {
  const [links,setLinks]=useState(initialLinks),[incoming,setIncoming]=useState(initialIncoming),[busy,setBusy]=useState(false),[status,setStatus]=useState("");
  async function refresh(){setLinks(listSchema(linkSchema).parse(await carePost({kind:"list",section:"caregivers",userId:profile.id})));setIncoming(listSchema(linkSchema).parse(await carePost({kind:"list",section:"incoming"})));}
  async function invite(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setStatus("");const form=new FormData(e.currentTarget);
    try{await patientPost("/api/consents",{userId:profile.id,type:"doctor_sharing",grant:true});
      await carePost({kind:"sharing",userId:profile.id,action:"invite_caregiver",data:{partnerId:String(form.get("accountCode")).trim(),scopes:[form.get("scope"),...(form.get("alerts")==="on"?["alerts"]:[])]}});
      await refresh();setStatus("Invitation saved. The caregiver must accept it in their own Family screen. No email has been sent.");}
    catch(error){setStatus(error instanceof Error?error.message:"Could not invite caregiver.");}finally{setBusy(false);}}
  async function change(userId:string,linkId:string,action:"accept_caregiver"|"revoke_caregiver"){setBusy(true);setStatus("");try{await carePost({kind:"sharing",userId,action,data:{linkId}});await refresh();setStatus(action==="accept_caregiver"?"Invitation accepted. Your access is read-only.":"Caregiver access revoked.");}catch(error){setStatus(error instanceof Error?error.message:"Sharing action failed.");}finally{setBusy(false);}}
  async function dependent(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setStatus("");const form=new FormData(e.currentTarget);
    try{const result=z.object({id:z.uuid()}).parse(await patientPost("/api/profiles/dependents",{name:form.get("name"),dob:form.get("dob"),consent:form.get("consent")==="on"}));
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Load the new owned profile through fresh server checks.
      window.location.href="/more/family?profile="+result.id;}
    catch(error){setStatus(error instanceof Error?error.message:"Could not create dependent.");setBusy(false);}}
  async function more(section:"caregivers"|"incoming"){setBusy(true);try{const next=listSchema(linkSchema).parse(await carePost({kind:"list",section,userId:section==="caregivers"?profile.id:undefined,cursor:section==="caregivers"?links.next_cursor:incoming.next_cursor}));if(section==="caregivers")setLinks(next);else setIncoming(next);}catch(error){setStatus(error instanceof Error?error.message:"Could not load more.");}finally{setBusy(false);}}
  return <div className="stack"><p role="status">{status}</p>
    <section className="card stack"><h2>Your account code</h2><p className="muted">Give this code to someone who wants to invite you as a caregiver. It does not grant access by itself.</p><code style={{overflowWrap:"anywhere"}}>{accountCode}</code></section>
    <section className="card stack"><h2>Shared with you</h2>{incoming.rows.length?incoming.rows.map(l=><div key={l.id} className="stack"><h3>{l.name}</h3><p>{l.status} · {l.granted_scopes.join(", ")}</p>
      {l.status==="invited"?<button className="button" disabled={busy} onClick={()=>change(l.patient_id,l.id,"accept_caregiver")}>Accept invitation from {l.name}</button>:<>
        {l.can_read_summary&&<a className="button secondary" href={"/today?profile="+l.patient_id}>View {l.name} read-only</a>}
        {l.can_read_history&&<a href={"/history?profile="+l.patient_id}>Read-only History</a>}{l.can_read_alerts&&<a href={"/doctor/alerts?profile="+l.patient_id}>Shared unusual readings</a>}
        {!l.can_read_summary&&!l.can_read_history&&!l.can_read_alerts&&<p className="muted">The owner has withdrawn sharing consent.</p>}
      </>}
    </div>):<p className="muted">No invitations or active shared profiles.</p>}{incoming.next_cursor&&<button className="button secondary" disabled={busy} onClick={()=>more("incoming")}>More shared profiles</button>}
      <p className="muted">Forwarded email alerts also require your own email opt-in in Alert rules and notifications. Sample readings use the labelled email stub.</p><a href="/more/alerts">Your notification settings</a>
    </section>
    <section className="card stack"><h2>Caregivers for {profile.name}</h2>{links.rows.length?links.rows.map(l=><div key={l.id} className="stack"><h3>{l.name}</h3><p>{l.role} · {l.status} · {l.granted_scopes.join(", ")}</p>
      {l.role==="guardian"?<p className="muted">This guardian owns the dependent profile. Mandatory guardian authority cannot be revoked here.</p>:l.status!=="revoked"&&<button className="button secondary" disabled={busy} onClick={()=>change(profile.id,l.id,"revoke_caregiver")}>Revoke {l.name}</button>}
    </div>):<p className="muted">No caregivers for this profile.</p>}{links.next_cursor&&<button className="button secondary" disabled={busy} onClick={()=>more("caregivers")}>More caregivers</button>}
      <form className="stack" onSubmit={invite}><label>Caregiver account code<input name="accountCode" required maxLength={36}/></label><label>Read-only scope<select name="scope" aria-label="Read-only scope"><option value="summary_only">Summary only</option><option value="full_history">Full history</option></select></label>
        <label className="check-label"><input type="checkbox" name="alerts"/>Also share alerts and allow forwarding after the caregiver opts in</label>
        <label className="check-label"><input type="checkbox" required/>I consent to sharing this profile with this caregiver within the selected scopes.</label><button className="button" disabled={busy}>Invite caregiver</button></form>
    </section>
    <section className="card stack"><h2>Dependent profiles</h2>{profiles.filter(p=>p.kind==="dependent").map(p=><div className="stack" key={p.id}><a href={"/more/family?profile="+p.id}>{p.name} · DOB {p.dob}</a><a href={"/more/data?profile="+p.id}>Manage separate data for {p.name}</a><a href={"/doctors?profile="+p.id}>Manage doctor sharing for {p.name}</a></div>)}
      <p className="muted">A dependent has no login. You own and manage their separate health history and give consent on their behalf. Verifiable parental consent needs legal approval before launch.</p>
      <form className="stack" onSubmit={dependent}><label>Dependent name<input name="name" required maxLength={120}/></label><label>Date of birth<input type="date" name="dob" required/></label><label className="check-label"><input type="checkbox" name="consent" required/>I am the adult guardian and consent to HMS storing and processing this dependent&apos;s health data.</label><button className="button" disabled={busy}>Create dependent profile</button></form>
    </section>
  </div>;
}
