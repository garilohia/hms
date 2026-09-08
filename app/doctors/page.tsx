import { patientPage } from "@/src/lib/patient/server";
import { AppFrame } from "../ui/frame";
export default async function DoctorsPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {view,profiles}=await patientPage("today",(await searchParams).profile);
  return <AppFrame profile={view.profile} profiles={profiles}><h1 className="page-title">Doctors</h1><section className="card stack"><h2 className="text-xl font-semibold">A doctor who knows your history.</h2><p>Doctor sharing and consultations are being added in the next milestone. No consultation has been requested and no doctor has been notified.</p><p className="muted">Not for emergencies. If you feel unwell, contact your doctor or local emergency services.</p></section></AppFrame>;
}
