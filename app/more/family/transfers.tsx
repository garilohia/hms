"use client";
import {useState,type FormEvent} from "react";
import {z} from "zod";
import {carePost,listSchema,transferSchema} from "@/src/lib/care/model";
import {patientPost,type PatientProfile} from "@/src/lib/patient/model";
export function Transfers({profile,actor,initial}:{profile:PatientProfile;actor:string;initial:z.infer<ReturnType<typeof listSchema<typeof transferSchema>>>}) {
  const [offers,setOffers]=useState(initial),[busy,setBusy]=useState(false),[status,setStatus]=useState("");
  async function change(userId:string,action:string,data:Record<string,unknown>){setBusy(true);setStatus("");try{
    await patientPost("/api/profiles/transfer",{userId,action,data});
    if(action==="accept"){
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Reload the transferred identity and current server authority.
      window.location.assign("/today?profile="+userId);return;
    }
    setOffers(listSchema(transferSchema).parse(await carePost({kind:"transfer_list"})));setStatus(action==="offer"?"Offer saved. The recipient must sign in and accept within seven days.":"Offer cancelled.");
  }catch(e){setStatus(e instanceof Error?e.message:"Transfer failed.");}finally{setBusy(false);}}
  function offer(e:FormEvent<HTMLFormElement>){e.preventDefault();const values=new FormData(e.currentTarget);void change(profile.id,"offer",{recipientId:String(values.get("recipient")).trim()});}
  function accept(e:FormEvent<HTMLFormElement>,id:string,userId:string){e.preventDefault();const values=new FormData(e.currentTarget);void change(userId,"accept",{offerId:id,acceptOwnership:values.get("ownership")==="on",replaceEmptyProfile:values.get("replace")==="on",consent:values.get("consent")==="on",disclaimer:values.get("disclaimer")==="on"});}
  async function more(){setBusy(true);try{setOffers(listSchema(transferSchema).parse(await carePost({kind:"transfer_list",cursor:offers.next_cursor})));}catch(e){setStatus(e instanceof Error?e.message:"Offers unavailable.");}finally{setBusy(false);}}
  return <section className="card stack"><h2>Adult account conversion</h2><p className="muted">At 18 or later, the guardian can offer this dependent&apos;s history to their own confirmed adult account. The recorded date of birth must match. The recipient needs a fresh, empty signup profile. Existing data is never merged or replaced.</p>
    {profile.kind==="dependent"&&<form className="stack" onSubmit={offer}><p>{profile.name} · DOB {profile.dob}</p><label>Recipient account code<input name="recipient" required maxLength={36}/></label><label className="check-label"><input type="checkbox" required/>I am the owning guardian and am offering this profile to the dependent&apos;s own account.</label><button className="button secondary" disabled={busy}>Offer adult account conversion</button></form>}
    {offers.rows.map(o=><article className="stack" key={o.id}><h3>Conversion offer for {o.name}</h3><p>DOB {o.dob} · Expires {o.expires_at.slice(0,10)}</p>
      {o.recipient_account_id===actor&&<form className="stack" onSubmit={e=>accept(e,o.id,o.user_id)}>
        <p className="muted">Your empty signup profile will be removed. This stable health profile and its history become yours. Previous sharing and contact permissions end. Historical guardian consent remains recorded.</p>
        <label className="check-label"><input type="checkbox" name="ownership" required/>This is my health profile. I accept ownership.</label>
        <label className="check-label"><input type="checkbox" name="replace" required/>Replace only my empty signup profile. Do not replace any established history.</label>
        <label className="check-label"><input type="checkbox" name="consent" required/>I consent to HMS storing and processing my health data.</label>
        <label className="check-label"><input type="checkbox" name="disclaimer" required/>I have read the health disclaimer.</label><a href="/legal/disclaimer">Read disclaimer</a>
        <button className="button" disabled={busy}>Accept ownership</button>
      </form>}
      <button className="button secondary" disabled={busy} onClick={()=>change(o.user_id,"cancel",{offerId:o.id})}>Cancel conversion offer</button>
    </article>)}{offers.next_cursor&&<button className="button secondary" disabled={busy} onClick={more}>More conversion offers</button>}<p role="status">{status}</p>
  </section>;
}
