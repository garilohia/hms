import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../../ui/frame";
import { AlertSettings } from "./settings";
import { PushTest } from "./push-test";
import { MonitoringRules } from "./monitoring-rules";
export default async function AlertsPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("today",(await searchParams).profile);
  return <AppFrame profile={view.profile} profiles={profiles}><div className="stack"><h1 className="page-title">Alert rules and notifications</h1>
    <p>These are unusual-reading notices, not a medical assessment. The app is not for emergencies.</p>
    <MonitoringRules profile={view.profile} />
    {view.can_manage ? <AlertSettings profiles={[view.profile]} /> : <p>Only the profile owner can change the app’s recommended default rules.</p>}<PushTest /></div></AppFrame>;
}
