import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../../ui/frame";
import { Records } from "../records";
import { DataManagement } from "./management";

export default async function DataPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("sources",(await searchParams).profile);
  return <AppFrame profile={view.profile} profiles={profiles}><div className="stack">
    <h1 className="page-title">Devices &amp; data</h1>
    <p>Import an Apple Health ZIP, one CSV, or a Google Fit/health CSV folder. Files are parsed on this device; only normalised readings are sent to HMS.</p>
    {view.can_manage?<DataManagement profile={view.profile}/>:<Records userId={view.profile.id} section="sources" />}
    {view.can_manage&&<a className="button secondary" href={"/today?profile="+view.profile.id}>View and refresh Today</a>}
    {view.can_manage&&<section className="card stack"><h2 className="font-semibold">Your data rights</h2>
      <p>Export includes all profiles you own, including dependents. It does not include patients linked to you as a doctor or caregiver. Keep the download open until it finishes.</p>
      <a className="button secondary" href="/api/account/export">Export all owned profiles</a>
      <a className="underline" href="/account/delete">Delete account and owned profiles</a>
    </section>}
    <p className="text-sm text-slate-600">Fitbit API and aggregator connections: coming soon.</p>
  </div></AppFrame>;
}
