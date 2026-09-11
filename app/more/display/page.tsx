import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../../ui/frame";
import { DisplaySettings } from "./settings";
export default async function DisplayPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("today",(await searchParams).profile);
  return <AppFrame profile={view.profile} profiles={profiles}><h1 className="page-title">Display</h1><DisplaySettings view={view}/></AppFrame>;
}
