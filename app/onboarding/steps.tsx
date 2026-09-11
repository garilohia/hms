"use client";
import { useState,type FormEvent } from "react";
import { patientPost,type PatientProfile } from "@/src/lib/patient/model";
import { DisplayModePicker } from "../more/display/picker";
import { DataImport } from "../more/data/upload";
export function Onboarding({initial,emailEnabled}:{initial:PatientProfile;emailEnabled:boolean}) {
  const [step,setStep]=useState(1),[profile,setProfile]=useState(initial),[busy,setBusy]=useState(false),[importing,setImporting]=useState(false),[error,setError]=useState("");
  const [mode,setMode]=useState(initial.display_mode),[cycle,setCycle]=useState(initial.cycle_tracking_enabled),[contactConsent,setContactConsent]=useState(false),[emailConsent,setEmailConsent]=useState(false),[disclaimer,setDisclaimer]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setError("");
    const values=Object.fromEntries(new FormData(event.currentTarget));
    try {
      if(step===1) {
        await patientPost("/api/profiles/settings",{userId:profile.id,action:"identity",payload:values});
        await patientPost("/api/profiles/settings",{userId:profile.id,action:"cycle",payload:{enabled:cycle}});
        await patientPost("/api/profiles/settings",{userId:profile.id,action:"display",payload:{mode}});
        setProfile({...profile,timezone:String(values.timezone)});setStep(2);
      } else if(step===3) {
        if(values.email) {
          await patientPost("/api/alerts/settings",{userId:profile.id,action:"contact",payload:values});
          if(contactConsent) await patientPost("/api/consents",{userId:profile.id,type:"emergency_contact",grant:true});
        } else if(contactConsent) throw new Error("Enter a contact email before giving forwarding consent.");
        if(emailConsent) await patientPost("/api/consents",{userId:profile.id,type:"alert_email",grant:true});
        setStep(4);
      } else if(step===4) {
        await patientPost("/api/profiles/settings",{userId:profile.id,action:"complete",payload:{disclaimer}});
        // A full navigation discards any pre-onboarding private page cache.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href="/today";
      }
    } catch(e) {setError(e instanceof Error?e.message:"Please try again.");} finally {setBusy(false);}
  }
  const titles=["Who you are","Connect your data","Who should we contact?","You’re in control."];
  return <><p className="muted">Step {step} of 4</p><h1 className="page-title">{titles[step-1]}</h1>
    {step===2?<div className="stack"><DataImport profiles={[profile]} onBusyChange={setImporting}/><button disabled={importing} className="button" onClick={()=>setStep(3)}>Continue</button><p className="muted">You can connect data later from More.</p></div>:
      <form className="stack" onSubmit={submit}>
        {step===1&&<>
          <label className="form-field">Name<input name="name" maxLength={120} required defaultValue={initial.name} autoComplete="name" /></label>
          <label className="form-field">Date of birth<input name="dob" type="date" required defaultValue={initial.dob} /></label>
          <label className="form-field">Sex at birth<select name="sex" required defaultValue={initial.sex_at_birth??""}><option value="" disabled>Choose</option><option value="female">Female</option><option value="male">Male</option><option value="intersex">Intersex</option><option value="prefer_not_to_say">Prefer not to say</option></select></label>
          <label className="form-field">Country of residence<input name="country" required defaultValue={initial.country_of_residence} maxLength={2} minLength={2} pattern="[A-Za-z]{2}" list="countries" /></label>
          <datalist id="countries"><option value="IN">India</option><option value="US">United States</option><option value="GB">United Kingdom</option><option value="AE">United Arab Emirates</option></datalist>
          <p className="muted">Use a two-letter country code. For example, IN, US, GB or AE.</p>
          <label className="form-field">Home timezone<input name="timezone" required defaultValue={initial.timezone} list="timezones" maxLength={80} /></label>
          <datalist id="timezones">{["Asia/Kolkata","Asia/Dubai","Europe/London","America/New_York","America/Los_Angeles","Australia/Sydney"].map(t=><option key={t} value={t}/>)}</datalist>
          <p className="muted">Your daily history uses this timezone. Choose it before importing; it cannot be changed after an import in this version.</p>
          <label className="check-field"><input type="checkbox" checked={cycle} onChange={e=>setCycle(e.target.checked)}/><span>Show cycle estimates (optional). For planning training and energy. Not for fertility or contraception.</span></label>
          <DisplayModePicker value={mode} onChange={setMode}/>
          <p className="muted">Under 18? An adult guardian creates a dependent profile from their account.</p>
        </>}
        {step===3&&<>
          <p>Optional. A contact can receive an email if an urgent reading remains unacknowledged for 15 minutes. This is not an emergency service.</p>
          <label className="form-field">Contact name<input name="name" maxLength={100}/></label>
          <label className="form-field">Contact phone<input name="phone" type="tel" maxLength={40}/></label>
          <label className="form-field">Contact email<input name="email" type="email" maxLength={254}/></label>
          <label className="check-field"><input type="checkbox" checked={contactConsent} onChange={e=>setContactConsent(e.target.checked)}/><span>I consent to sharing unacknowledged urgent readings with this contact by email.</span></label>
          <label className="check-field"><input type="checkbox" checked={emailConsent} onChange={e=>setEmailConsent(e.target.checked)}/><span>Email me unusual-reading notices.</span></label>
          <p className="muted">{!emailEnabled&&"Email delivery is in test mode until the sender is configured. "}Sample data never sends external notifications. You can change consent in More.</p>
        </>}
        {step===4&&<div className="card stack"><p>Your health history is private. A doctor or caregiver only gets access when you choose to share it. You can revoke ordinary sharing.</p>
          <p>HMS is not a medical device. It does not diagnose conditions or provide medical advice. Consumer wearable readings can be incomplete or inaccurate. Discuss unusual readings with your doctor.</p>
          <p>Not for emergencies. If you need urgent help, contact your local emergency services. Do not wait for this app or a doctor here to respond.</p>
          <a className="underline" href="/legal/disclaimer" target="_blank" rel="noreferrer">Read the disclaimer</a>
          <label className="check-field"><input type="checkbox" checked={disclaimer} onChange={e=>setDisclaimer(e.target.checked)}/><span>I have read and understood the disclaimer.</span></label>
        </div>}
        {error&&<p role="alert">{error}</p>}
        <button className="button" disabled={busy||(step===4&&!disclaimer)}>{busy?"Saving…":step===4?"Open Today":"Continue"}</button>
      </form>}
  </>;
}
