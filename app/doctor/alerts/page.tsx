import {patientPage} from "@/src/lib/patient/server";
import {AppFrame} from "../../ui/frame";
import {SharedAlerts} from "./readings";
export default async function DoctorAlertsPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view}=await patientPage("alerts",(await searchParams).profile);
  return <AppFrame profile={view.profile}><h1 className="page-title">Unusual readings</h1><SharedAlerts initial={view}/></AppFrame>;
}
