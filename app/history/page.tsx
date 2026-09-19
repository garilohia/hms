import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../ui/frame";
import { History } from "./history";
import {careRead} from "@/src/lib/care/server";
import {consultRowSchema,listSchema} from "@/src/lib/care/model";
import {ConsultNotes} from "./consult-notes";
export default async function HistoryPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles,today}=await patientPage("history",(await searchParams).profile);
  const notes=listSchema(consultRowSchema).parse(await careRead({kind:"consult_list",userId:view.profile.id,history:true}));
  return <AppFrame profile={view.profile} profiles={profiles}><h1 className="page-title">History</h1><History key={"history:"+view.profile.id} initial={view} today={today}/><ConsultNotes key={"consults:"+view.profile.id} userId={view.profile.id} initial={notes}/></AppFrame>;
}
