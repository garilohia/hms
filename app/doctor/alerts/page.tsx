import {patientPage} from "@/src/lib/patient/server";
import {AppFrame} from "../../ui/frame";
import {SharedAlerts} from "./readings";
import {MonitoringRules} from "../../more/alerts/monitoring-rules";
import {PushTest} from "../../more/alerts/push-test";
export default async function DoctorAlertsPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view}=await patientPage("alerts",(await searchParams).profile);
  return <AppFrame profile={view.profile}><div className="stack"><h1 className="page-title">Unusual readings</h1><MonitoringRules profile={view.profile}/><PushTest/><SharedAlerts initial={view}/></div></AppFrame>;
}
