"use client";
import {useState,type FormEvent} from "react";
import {carePost,doctorSchema,type Doctor} from "@/src/lib/care/model";
export function DoctorRegistration({initial}:{initial:Doctor|null}) {
  const [doctor,setDoctor]=useState(initial),[busy,setBusy]=useState(false),[status,setStatus]=useState("");
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setStatus("");const values=new FormData(event.currentTarget);
    try {setDoctor(doctorSchema.parse(await carePost({kind:"doctor",action:"register",data:{registrationNumber:values.get("registration"),council:values.get("council"),
      specialities:String(values.get("specialities")).split(",").map(v=>v.trim()).filter(Boolean),languages:String(values.get("languages")).split(",").map(v=>v.trim()).filter(Boolean),
      bio:values.get("bio"),feeInr:Number(values.get("inr")),feeUsd:Number(values.get("usd")),available:values.get("available")==="on"}})));setStatus("Saved. Credential changes require administrator verification.");}
    catch(error){setStatus(error instanceof Error?error.message:"Registration failed.");}finally{setBusy(false);}
  }
  return <section className="card stack"><h2>Doctor registration</h2><p className="muted">{doctor?.verified_at?"Verified by an administrator.":"Pending verification. Patient access is unavailable until an administrator verifies your registration."}</p>
    {doctor?.is_sample&&<p className="sample-badge">Sample data. This is not a real practitioner.</p>}
    <form className="stack" onSubmit={submit}>
      <label>Registration number<input name="registration" required maxLength={100} defaultValue={doctor?.registration_number}/></label>
      <label>Registering council<input name="council" required maxLength={120} defaultValue={doctor?.registering_council}/></label>
      <label>Specialities (comma-separated)<input name="specialities" required maxLength={800} defaultValue={doctor?.specialities.join(", ")}/></label>
      <label>Languages (comma-separated)<input name="languages" required maxLength={800} defaultValue={doctor?.languages.join(", ")||"English"}/></label>
      <label>About you<textarea name="bio" maxLength={1200} defaultValue={doctor?.bio}/></label>
      <label>Consult fee (INR)<input name="inr" type="number" required min={0} max={100000} step="0.01" defaultValue={doctor?.consult_fee_inr??0}/></label>
      <label>Consult fee (USD)<input name="usd" type="number" required min={0} max={2000} step="0.01" defaultValue={doctor?.consult_fee_usd??0}/></label>
      <label className="check-label"><input name="available" type="checkbox" defaultChecked={doctor?.available??false}/>Accept consult requests. Appointment time is agreed after a request.</label>
      <button className="button" disabled={busy}>{busy?"Saving…":"Save registration"}</button>
    </form><p role="status">{status}</p>
  </section>;
}
