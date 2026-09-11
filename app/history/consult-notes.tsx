"use client";
import {useState} from "react";
import {z} from "zod";
import {carePost,consultRowSchema,listSchema} from "@/src/lib/care/model";
export function ConsultNotes({userId,initial}:{userId:string;initial:z.infer<ReturnType<typeof listSchema<typeof consultRowSchema>>>}) {
  const [notes,setNotes]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function more(){setBusy(true);try{setNotes(listSchema(consultRowSchema).parse(await carePost({kind:"consult_list",userId,history:true,cursor:notes.next_cursor})));}catch(e){setError(e instanceof Error?e.message:"Notes unavailable.");}finally{setBusy(false);}}
  return <section className="card stack" style={{marginTop:18}}><h2>Consult notes</h2>{notes.rows.length?notes.rows.map(c=><article key={c.id} className="stack">{c.is_sample&&<p className="sample-badge">Sample data</p>}<h3>{c.doctor_name}, {c.type.replaceAll("_"," ")}</h3><p className="muted">Completed {c.completed_at?.slice(0,10)}</p><p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{c.doctor_note}</p></article>):<p className="muted">No completed consult notes.</p>}{notes.next_cursor&&<button className="button secondary" disabled={busy} onClick={more}>Earlier notes</button>}<p role="status">{error}</p></section>;
}
