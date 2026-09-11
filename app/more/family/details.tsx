"use client";
import {useState,type FormEvent} from "react";
import {patientPost,type PatientProfile} from "@/src/lib/patient/model";
export function DependentDetails({profile}:{profile:PatientProfile}){
  const [busy,setBusy]=useState(false),[status,setStatus]=useState("");
  async function save(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setStatus("");const payload=Object.fromEntries(new FormData(e.currentTarget));
    try{await patientPost("/api/profiles/settings",{userId:profile.id,action:"identity",payload});window.location.reload();}catch(error){setStatus(error instanceof Error?error.message:"Details could not be saved.");setBusy(false);}}
  return <section className="card stack"><h2>Dependent details</h2><form className="stack" onSubmit={save}>
    <label>Name<input name="name" required maxLength={120} defaultValue={profile.name}/></label><label>Date of birth<input name="dob" type="date" required defaultValue={profile.dob}/></label>
    <label>Sex at birth<select name="sex" required defaultValue={profile.sex_at_birth||""}><option value="" disabled>Choose</option><option value="female">Female</option><option value="male">Male</option><option value="intersex">Intersex</option><option value="prefer_not_to_say">Prefer not to say</option></select></label>
    <label>Country code<input name="country" required minLength={2} maxLength={2} defaultValue={profile.country_of_residence}/></label>
    <label>History timezone<input name="timezone" required maxLength={100} defaultValue={profile.timezone}/></label><p className="muted">For example Asia/Kolkata or Europe/London. Changing this recalculates the daily history that has already been imported.</p>
    <button className="button secondary" disabled={busy}>Save dependent details</button></form><p role="status">{status}</p></section>;
}
