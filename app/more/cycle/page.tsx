import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../../ui/frame";
import { CycleSettings } from "./settings";
export default async function CyclePage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("today",(await searchParams).profile);
  return <AppFrame profile={view.profile} profiles={profiles}><h1 className="page-title">Cycle tracking</h1><CycleSettings view={view}/></AppFrame>;
}
