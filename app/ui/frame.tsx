"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { PatientProfile } from "@/src/lib/patient/model";
export function AppFrame({children,profile,profiles=[]}:{children:ReactNode;profile?:PatientProfile;profiles?:PatientProfile[]}) {
  const path=usePathname();
  const suffix=profile?"?profile="+profile.id:"";
  // Full navigations recheck current sharing and avoid cached private RSC views.
  return <div className="app-frame">
    <header className="app-header"><a className="app-brand" href={"/today"+suffix}>HMS</a><a href={"/more"+suffix}>More</a>
      {profile && <div className="profile-control">{profiles.length>1?<label>Viewing profile<select aria-label="Viewing profile" value={profile.id} onChange={e=>{window.location.href=path+"?profile="+e.target.value;}}>
        {!profiles.some(p=>p.id===profile.id)&&<option value={profile.id}>{profile.name} · Shared, read-only</option>}
        {profiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.kind==="dependent"?" · Dependent":""}</option>)}
      </select></label>:<span>{profile.name}{profile.kind==="dependent"?" · Dependent":""}</span>}</div>}
    </header>
    <main>{children}</main>
    <nav aria-label="Main tabs" className="main-tabs">{["Today","Doctors","History"].map(name=>{const href="/"+name.toLowerCase();return <a key={name} aria-current={path===href?"page":undefined} href={href+suffix}>{name}</a>;})}</nav>
  </div>;
}
