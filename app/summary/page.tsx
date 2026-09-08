import {notFound} from "next/navigation";
import {z} from "zod";
import {ownedProfiles} from "@/src/lib/patient/server";
import {careRead} from "@/src/lib/care/server";
import {clinicalSnapshotSchema} from "@/src/lib/care/clinical-model";
import {AppFrame} from "../ui/frame";
import {ClinicalSummary} from "./summary";
export default async function SummaryPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {profiles}=await ownedProfiles(),id=(await searchParams).profile||profiles.find(p=>p.kind==="self")?.id;
  if(!id||!z.uuid().safeParse(id).success)notFound();
  const snapshot=clinicalSnapshotSchema.parse(await careRead({kind:"summary",userId:id,days:30}));
  return <AppFrame><h1 className="page-title">Clinical summary</h1><ClinicalSummary initial={snapshot} owner={profiles.some(p=>p.id===id)}/></AppFrame>;
}
