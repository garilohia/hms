"use client";
import { useState } from "react";
import { patientPost,type DisplayMode,type PatientView } from "@/src/lib/patient/model";
import { DisplayModePicker } from "./picker";
export function DisplaySettings({view}:{view:PatientView}) {
  const [mode,setMode]=useState<DisplayMode>(view.profile.display_mode),[status,setStatus]=useState(""),[busy,setBusy]=useState(false);
  async function choose(next:DisplayMode) {
    const previous=mode;setMode(next);setBusy(true);setStatus("");
    try { await patientPost("/api/profiles/settings",{userId:view.profile.id,action:"display",payload:{mode:next}}); setStatus("Saved. Screens use the "+next+" density from the next page load."); }
    catch(error) { setMode(previous); setStatus(error instanceof Error?error.message:"Could not save."); }
    finally { setBusy(false); }
  }
  return <div className="card stack"><p>Choose how much each screen shows. Navigation, alerts and copy stay the same in every density. The choice is stored for this profile only.</p>
    <DisplayModePicker value={mode} onChange={mode=>void choose(mode)} disabled={busy||!view.can_manage}/>
    {!view.can_manage&&<p className="muted">Only the profile owner can change the display density.</p>}
    <p role="status">{status}</p></div>;
}
