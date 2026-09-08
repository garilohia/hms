import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../ui/frame";
import { History } from "./history";
export default async function HistoryPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles,today}=await patientPage("history",(await searchParams).profile);
  return <AppFrame profile={view.profile} profiles={profiles}><h1 className="page-title">History</h1><History initial={view} today={today}/></AppFrame>;
}
