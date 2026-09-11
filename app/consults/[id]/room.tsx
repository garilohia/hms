"use client";
import {useRef,useState,type FormEvent} from "react";
import {RetryIds} from "@/src/lib/care/retry";
import {z} from "zod";
import {carePost,consultViewSchema} from "@/src/lib/care/model";
import {useRealtimeConsult} from "@/src/lib/care/realtime";
export function ConsultRoom({initial,actor}:{initial:z.infer<typeof consultViewSchema>;actor:string}) {
  const messageIds=useRef(new RetryIds());
  const {view,setView,live}=useRealtimeConsult(initial);
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(""),[message,setMessage]=useState(""),[note,setNote]=useState("");
  const c=view.consult,open=c.status==="accepted"||c.status==="scheduled";
  async function refresh(earlier=false) {
    setBusy(true);setStatus("");try{setView(consultViewSchema.parse(await carePost({kind:"consult_read",id:c.id,cursor:earlier?view.next_cursor:null})));}
    catch(e){setStatus(e instanceof Error?e.message:"Consult unavailable.");}finally{setBusy(false);}
  }
  async function act(action:string,data:Record<string,unknown>={}) {
    let saved=false;
    setBusy(true);setStatus("");try{await carePost({kind:"consult",userId:c.patient_id,action,data:{consultId:c.id,...data}});saved=true;
      if(action==="message"){setMessage("");messageIds.current.confirmed(c.id);}
      setView(consultViewSchema.parse(await carePost({kind:"consult_read",id:c.id})));setStatus("Saved.");}
    catch(e){setStatus((e instanceof Error?e.message:"Could not save.")+(saved?" Saved, but the view could not refresh. Reload to see it.":" The change may have saved. Refresh to check, or retry an unchanged message."));}finally{setBusy(false);}
  }
  async function schedule(e:FormEvent<HTMLFormElement>){e.preventDefault();const data=new FormData(e.currentTarget);await act("schedule",{scheduledFor:new Date(String(data.get("time"))).toISOString(),callUrl:data.get("url")});}
  return <div className="stack"><section className="card stack"><h2>{view.patient_name} with {view.doctor_name}</h2><p>{c.type.replaceAll("_"," ")}, <strong>{c.status}</strong></p>
    {view.is_sample&&<p className="sample-badge">Sample data. This is a demonstration, not a real consultation.</p>}
    {c.patient_note&&<p>{c.patient_note}</p>}{c.scheduled_for&&<p>Scheduled: {c.scheduled_for.replace("T"," ")} (UTC)</p>}
    {c.attached_summary_id&&<a href={"/api/clinical-summary?profile="+c.patient_id+"&snapshot="+c.attached_summary_id}>Download attached summary</a>}
    {c.call_url&&open&&<a className="button secondary" href={c.call_url} target="_blank" rel="noopener noreferrer">Join call</a>}
    <p className="muted">Not for emergencies. A requested review is not a promise of an immediate response.</p>
    {view.is_doctor&&c.status==="requested"&&<button className="button" disabled={busy} onClick={()=>act("accept")}>Accept consult</button>}
    {view.can_manage&&["requested","accepted","scheduled"].includes(c.status)&&<button className="button secondary" disabled={busy} onClick={()=>act("cancel")}>Cancel consult</button>}
  </section>
  {view.is_doctor&&["requested","accepted","scheduled"].includes(c.status)&&<section className="card stack"><h2>Schedule</h2><form className="stack" onSubmit={schedule}>
    <label>Appointment time (your browser timezone)<input type="datetime-local" name="time" required/></label><label>Optional Google Meet or Zoom link<input type="url" name="url" maxLength={300} placeholder="https://meet.google.com/…"/></label>
    <p className="muted">Paste a link you have arranged. HMS does not create a video meeting.</p><button className="button secondary" disabled={busy}>Save appointment</button></form></section>}
  <section className="card stack"><h2>Messages</h2>
    {live==="offline"&&<p className="muted" role="status">Live connection interrupted; retrying automatically</p>}
    <button className="button secondary" disabled={busy} onClick={()=>refresh()}>Refresh messages</button>
    {view.messages.length?[...view.messages].reverse().map(m=><div key={m.id} className="message-row"><p className="muted">{m.sender_id===actor?"You":"Other participant"}, {m.sent_at.replace("T"," ")}</p><p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{m.body}</p></div>):<p className="muted">No messages yet.</p>}
    {view.next_cursor&&<button className="button secondary" disabled={busy} onClick={()=>refresh(true)}>Earlier messages</button>}
    {open?<form className="stack" onSubmit={e=>{e.preventDefault();void act("message",{body:message,messageId:messageIds.current.id(c.id,message)});}}><label>Message<textarea required disabled={busy} maxLength={4000} value={message} onChange={e=>setMessage(e.target.value)}/></label><button className="button" disabled={busy||!message.trim()}>Send message</button></form>:<p className="muted">Chat opens after acceptance and closes with the consult.</p>}
  </section>
  {view.is_doctor&&open&&<section className="card stack"><h2>Close with a note</h2><label>Doctor note<textarea maxLength={10000} value={note} onChange={e=>setNote(e.target.value)}/></label><button className="button" disabled={busy||!note.trim()} onClick={()=>act("close",{note})}>Close consult</button></section>}
  {c.doctor_note&&<section className="card stack"><h2>Doctor note</h2><p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{c.doctor_note}</p></section>}
  <p role="status">{status}</p></div>;
}
