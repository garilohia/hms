import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../../ui/frame";
import { Records } from "../records";
import { DataManagement } from "./management";

export default async function DataPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("sources",(await searchParams).profile);
  return <AppFrame profile={view.profile} profiles={profiles}><div className="stack">
    <h1 className="page-title">Devices &amp; data</h1>
    <p>Import an Apple Health ZIP or a CSV. Your archive stays on this device. Only normalised readings are sent to HMS.</p>
    {view.can_manage?<DataManagement profile={view.profile}/>:<Records userId={view.profile.id} section="sources" />}
    {view.can_manage&&<a className="button secondary" href={"/today?profile="+view.profile.id}>View and refresh Today</a>}
    <p className="text-sm text-slate-600">Fitbit API and aggregator connections: coming soon.</p>
  </div></AppFrame>;
}
