import { redirect } from "next/navigation";
import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../ui/frame";
import { Today } from "./today";
export default async function TodayPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("today",(await searchParams).profile);
  if(view.can_manage && view.profile.kind==="self" && !view.profile.onboarding_completed_at) redirect("/onboarding");
  return <AppFrame profile={view.profile} profiles={profiles}><h1 className="page-title">Today</h1><Today initial={view} /></AppFrame>;
}
