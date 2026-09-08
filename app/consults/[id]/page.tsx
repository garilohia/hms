import {notFound} from "next/navigation";
import {z} from "zod";
import {ownedProfiles} from "@/src/lib/patient/server";
import {careRead} from "@/src/lib/care/server";
import {consultViewSchema} from "@/src/lib/care/model";
import {AppFrame} from "../../ui/frame";
import {ConsultRoom} from "./room";
export default async function ConsultPage({params}:{params:Promise<{id:string}>}) {
  const {id}=await params;if(!z.uuid().safeParse(id).success)notFound();
  const {session}=await ownedProfiles(),view=consultViewSchema.parse(await careRead({kind:"consult_read",id}));
  return <AppFrame><h1 className="page-title">Consult</h1><ConsultRoom initial={view} actor={session.user.id}/></AppFrame>;
}
