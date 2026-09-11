"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { PatientProfile } from "@/src/lib/patient/model";

// Tab icons pair the sage active colour with a word (§10: no meaning carried by colour alone).
const tabIcons: Record<string, ReactNode> = {
  Today: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12h5l2-6 3 12 3-8 2 2h5"/></svg>,
  Doctors: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>,
  History: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19V5M4 19h16"/><path d="M8 15l4-5 3 3 4-6"/></svg>,
};

export function AppFrame({children,profile,profiles=[]}:{children:ReactNode;profile?:PatientProfile;profiles?:PatientProfile[]}) {
  const path=usePathname();
  const suffix=profile?"?profile="+profile.id:"";
  // Full navigations recheck current sharing and avoid cached private RSC views.
  return <div className="app-frame" data-mode={profile?.display_mode??"standard"}>
    <header className="app-header"><a className="app-brand" href={"/today"+suffix}>HMS</a><a href={"/more"+suffix}>More</a>
      {profile && <div className="profile-control">{profiles.length>1?<label>Viewing profile<select aria-label="Viewing profile" value={profile.id} onChange={e=>{window.location.href=path+"?profile="+e.target.value;}}>
        {!profiles.some(p=>p.id===profile.id)&&<option value={profile.id}>{profile.name} (shared, read-only)</option>}
        {profiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.kind==="dependent"?" (dependent)":""}</option>)}
      </select></label>:<span>{profile.name}{profile.kind==="dependent"?" (dependent)":""}</span>}</div>}
    </header>
    <main>{children}</main>
    <nav aria-label="Main tabs" className="main-tabs">{["Today","Doctors","History"].map(name=>{const href="/"+name.toLowerCase();return <a key={name} aria-current={path===href?"page":undefined} href={href+suffix}>{tabIcons[name]}{name}</a>;})}</nav>
  </div>;
}
