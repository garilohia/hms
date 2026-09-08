import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../ui/frame";
import {careRead} from "@/src/lib/care/server";
import {doctorSchema,linkSchema,consultRowSchema,listSchema} from "@/src/lib/care/model";
import {DoctorTeam} from "./team";
export default async function DoctorsPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("today",(await searchParams).profile);
  if(!view.can_manage)return <AppFrame profile={view.profile}><h1 className="page-title">Doctors</h1><p className="card">Only the patient or owning guardian can manage sharing and request a consult.</p></AppFrame>;
  const [directory,links,consults]=await Promise.all([careRead({kind:"list",section:"directory"}),careRead({kind:"list",section:"doctors",userId:view.profile.id}),careRead({kind:"consult_list",userId:view.profile.id})]);
  return <AppFrame profile={view.profile} profiles={profiles}><h1 className="page-title">Doctors</h1><DoctorTeam userId={view.profile.id} initialDirectory={listSchema(doctorSchema).parse(directory)} initialLinks={listSchema(linkSchema).parse(links)} initialConsults={listSchema(consultRowSchema).parse(consults)}/></AppFrame>;
}
